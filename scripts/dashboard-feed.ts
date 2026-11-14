/**
 * Dashboard feed for the app's Today and Ops boards.
 *
 * Host-side collector, run every few minutes (systemd timer / launchd). It reads
 * sources through the same private config as the brokers (home.yaml `dashboard`)
 * and writes one JSON file the app channel serves to the people allowed to see
 * each board (GET /v1/dashboard). Agents are not involved and never see this file.
 *
 *   Today: weather (Open-Meteo, no key), today's and this week's events from the
 *          configured calendars (Google grants held by the broker, read scope).
 *   Ops:   service health (Gatus API), alerts from the last 24 h (alerts.db),
 *          pending approvals and scheduled tasks (via `ncl`, never the DB).
 *
 * Every section is collected independently; a failing source becomes a section
 * with `error` so the rest of the board still shows.
 *
 *   pnpm exec tsx scripts/dashboard-feed.ts [--out data/app-channel/dashboard.json] [--print]
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import Database from 'better-sqlite3';

import { GoogleTokens } from './google-broker.js';
import { type HomeConfig, loadHomeConfig } from './home-config.js';

const execFileAsync = promisify(execFile);
const CAL = 'https://www.googleapis.com/calendar/v3';

export type RowStatus = 'ok' | 'warn' | 'bad' | 'info';

export interface Row {
  title: string;
  detail?: string;
  status?: RowStatus;
  time?: string;
}

export interface DashEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  location?: string;
}

export type Section =
  | { id: string; kind: 'weather'; title: string; error?: string; weather?: Weather }
  | {
      id: string;
      kind: 'events';
      title: string;
      error?: string;
      days?: Array<{ date: string; label: string; events: DashEvent[] }>;
    }
  | { id: string; kind: 'rows'; title: string; error?: string; summary?: string; rows?: Row[] };

export interface Weather {
  label: string;
  temperature: number;
  code: number;
  text: string;
  high: number;
  low: number;
  unit: string;
}

export interface Board {
  id: 'today' | 'ops';
  title: string;
  audience: string[];
  sections: Section[];
}

export interface DashboardFile {
  version: 1;
  generatedAt: string;
  timezone: string;
  boards: Board[];
}

// ---- time helpers (install timezone) ------------------------------------------------------

/** YYYY-MM-DD of `d` in `tz`. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    d,
  );
}

/** UTC instant of local midnight for a YYYY-MM-DD date in `tz`. */
export function localMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  // Two passes settle DST: shift by the zone offset observed at the guess.
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const asLocal = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
    guess -= asLocal - Date.UTC(y, m - 1, d);
  }
  return new Date(guess);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---- Today ---------------------------------------------------------------------------------

const WEATHER_TEXT: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Showers',
  81: 'Showers',
  82: 'Heavy showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};

export async function collectWeather(
  cfg: NonNullable<HomeConfig['dashboard']>['weather'],
  fetchFn = fetch,
): Promise<Section> {
  const section: Section = { id: 'weather', kind: 'weather', title: 'Weather' };
  if (!cfg) return { ...section, error: 'no location configured' };
  if (cfg.provider === 'nws') return { ...section, weather: await nwsWeather(cfg, fetchFn) };
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${cfg.latitude}&longitude=${cfg.longitude}` +
    '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto' +
    (cfg.unit === 'fahrenheit' ? '&temperature_unit=fahrenheit' : '');
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { ...section, error: `weather service ${res.status}` };
  const j = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    current_units?: { temperature_2m?: string };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  };
  const code = j.current?.weather_code ?? -1;
  return {
    ...section,
    weather: {
      label: cfg.label,
      temperature: Math.round(j.current?.temperature_2m ?? NaN),
      code,
      text: WEATHER_TEXT[code] ?? '—',
      high: Math.round(j.daily?.temperature_2m_max?.[0] ?? NaN),
      low: Math.round(j.daily?.temperature_2m_min?.[0] ?? NaN),
      unit: j.current_units?.temperature_2m ?? '°C',
    },
  };
}

/** Map a National Weather Service short forecast to the WMO-style code the app draws icons from. */
export function nwsCode(text: string): number {
  const t = text.toLowerCase();
  if (t.includes('thunder')) return 95;
  if (t.includes('snow') || t.includes('flurr') || t.includes('sleet')) return 73;
  if (t.includes('drizzle')) return 53;
  if (t.includes('rain') || t.includes('shower')) return 63;
  if (t.includes('fog') || t.includes('haze') || t.includes('smoke')) return 45;
  if (t.includes('partly') || t.includes('mostly sunny') || t.includes('mostly clear')) return 2;
  if (t.includes('cloudy') || t.includes('overcast')) return 3;
  if (t.includes('sunny') || t.includes('clear')) return 0;
  return -1;
}

/** US National Weather Service (api.weather.gov): free, no key, US locations only. */
async function nwsWeather(
  cfg: NonNullable<NonNullable<HomeConfig['dashboard']>['weather']>,
  fetchFn: typeof fetch,
): Promise<Weather> {
  const headers = { 'user-agent': 'nanoclaw-dashboard', accept: 'application/geo+json' };
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`weather service ${res.status}`);
    return (await res.json()) as T;
  };
  const points = await get<{ properties?: { forecast?: string; forecastHourly?: string } }>(
    `https://api.weather.gov/points/${cfg.latitude.toFixed(4)},${cfg.longitude.toFixed(4)}`,
  );
  const units = cfg.unit === 'celsius' ? '?units=si' : '';
  if (!points.properties?.forecast || !points.properties.forecastHourly) throw new Error('location not covered by NWS');
  type Period = { temperature: number; temperatureUnit: string; shortForecast: string; isDaytime: boolean };
  const [hourly, daily] = await Promise.all([
    get<{ properties?: { periods?: Period[] } }>(points.properties.forecastHourly + units),
    get<{ properties?: { periods?: Period[] } }>(points.properties.forecast + units),
  ]);
  const now = hourly.properties?.periods?.[0];
  const periods = daily.properties?.periods ?? [];
  const day = periods.find((p) => p.isDaytime);
  const night = periods.find((p) => !p.isDaytime);
  const text = now?.shortForecast ?? '—';
  return {
    label: cfg.label,
    temperature: now?.temperature ?? NaN,
    code: nwsCode(text),
    text,
    high: day?.temperature ?? NaN,
    low: night?.temperature ?? NaN,
    unit: `°${now?.temperatureUnit ?? (cfg.unit === 'celsius' ? 'C' : 'F')}`,
  };
}

interface GEvent {
  summary?: string;
  status?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** Reads one configured calendar's events between two instants with the account's read scope. */
export class CalendarReader {
  private ids = new Map<string, string>();
  constructor(
    private cfg: HomeConfig,
    private tokens: { token(account: string, scope: string): Promise<string> },
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async get<T>(account: string, scope: string, url: string): Promise<T> {
    const token = await this.tokens.token(account, scope);
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
    if (!res.ok) throw new Error(`Google API error ${res.status}`);
    return (await res.json()) as T;
  }

  async events(calendarId: string, from: Date, to: Date): Promise<DashEvent[]> {
    const cal = this.cfg.calendars.find((c) => c.id === calendarId);
    if (!cal) throw new Error(`unknown calendar ${calendarId}`);
    const scopes = this.cfg.google_accounts.find((a) => a.id === cal.account)?.scopes ?? [];
    const scope = scopes.includes('calendar.readonly') ? 'calendar.readonly' : 'calendar.events.owned';
    let gid = cal.calendar;
    if (gid !== 'primary' && !gid.includes('@')) {
      const key = `${cal.account}/${gid}`;
      if (!this.ids.has(key)) {
        const list = await this.get<{ items?: Array<{ id: string; summary?: string; summaryOverride?: string }> }>(
          cal.account,
          'calendar.calendarlist.readonly',
          `${CAL}/users/me/calendarList?maxResults=250`,
        );
        const hit = (list.items ?? []).filter((c) => c.summaryOverride === gid || c.summary === gid);
        if (hit.length !== 1) throw new Error(`calendar "${gid}" not found`);
        this.ids.set(key, hit[0]!.id);
      }
      gid = this.ids.get(key)!;
    }
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
    });
    const res = await this.get<{ items?: GEvent[] }>(
      cal.account,
      scope,
      `${CAL}/calendars/${encodeURIComponent(gid)}/events?${params}`,
    );
    return (res.items ?? [])
      .filter((e) => e.status !== 'cancelled')
      .map((e) => ({
        title: (e.summary ?? '(no title)').slice(0, 200),
        start: e.start?.dateTime ?? e.start?.date ?? '',
        end: e.end?.dateTime ?? e.end?.date ?? '',
        allDay: !e.start?.dateTime,
        calendar: calendarId,
        ...(e.location ? { location: e.location.slice(0, 200) } : {}),
      }));
  }
}

/** Group events into Today / Tomorrow / weekday buckets for the next 7 days. */
export function bucketEvents(
  events: DashEvent[],
  today: string,
  tz: string,
): Array<{ date: string; label: string; events: DashEvent[] }> {
  const days: Array<{ date: string; label: string; events: DashEvent[] }> = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(today, i);
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : new Intl.DateTimeFormat('en-GB', {
              timeZone: 'UTC',
              weekday: 'long',
              day: 'numeric',
              month: 'short',
            }).format(new Date(`${date}T12:00:00Z`));
    days.push({ date, label, events: [] });
  }
  for (const e of events) {
    const startDate = e.allDay ? e.start : localDate(new Date(e.start), tz);
    // All-day events span [start, end); show them on every covered day in range.
    const endDate = e.allDay ? addDays(e.end, -1) : startDate;
    for (const d of days) if (d.date >= startDate && d.date <= endDate) d.events.push(e);
  }
  for (const d of days) d.events.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  return days;
}

export async function collectEvents(
  cfg: HomeConfig,
  reader: CalendarReader,
  tz: string,
  now = new Date(),
): Promise<Section> {
  const section: Section = { id: 'events', kind: 'events', title: 'Calendar' };
  const ids = cfg.dashboard?.today_calendars ?? [];
  const today = localDate(now, tz);
  const from = localMidnight(today, tz);
  const to = localMidnight(addDays(today, 7), tz);
  const all: DashEvent[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      all.push(...(await reader.events(id, from, to)));
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  return { ...section, days: bucketEvents(all, today, tz), ...(errors.length ? { error: errors.join('; ') } : {}) };
}

// ---- Tasks (per person, read-only through the bridges) -----------------------------------

/**
 * Minimal MCP client for one tool call over Streamable HTTP: initialize (keeping a session id when
 * the server issues one), then tools/call. Accepts JSON or SSE responses. Returns structuredContent,
 * else the first text block parsed as JSON.
 */
export async function mcpCall(
  url: string,
  key: string,
  tool: string,
  args: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  let session: string | null = null;
  const post = async (body: object): Promise<{ res: Response; msg: Record<string, unknown> | null }> => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-caller-key': key,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 202 || res.status === 204) return { res, msg: null };
    const text = await res.text();
    if (!res.ok) throw new Error(`${tool}: bridge ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
    const payloads = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
      : [text];
    const msgs = payloads.filter(Boolean).map((p) => JSON.parse(p) as Record<string, unknown>);
    return { res, msg: msgs.find((m) => 'id' in m) ?? msgs[msgs.length - 1] ?? null };
  };
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'nanoclaw-dashboard', version: '1' },
    },
  });
  session = init.res.headers.get('mcp-session-id');
  if (session) await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const { msg } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  if (!msg) throw new Error(`${tool}: empty response`);
  if (msg.error) throw new Error(`${tool}: ${(msg.error as { message?: string }).message ?? 'error'}`);
  const result = msg.result as {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${tool}: ${text.slice(0, 160)}`);
  if (result.structuredContent !== undefined) {
    const sc = result.structuredContent as Record<string, unknown>;
    // FastMCP wraps non-object returns as {result: …}.
    return Object.keys(sc).length === 1 && 'result' in sc ? sc.result : sc;
  }
  return JSON.parse(text);
}

export interface TaskBridges {
  key: string;
  remindersUrl?: string;
  omnifocusUrl?: string;
}

/** Due-date label and urgency relative to today (install timezone). */
function dueRow(due: string | null | undefined, today: string, tz: string): { status: RowStatus; when: string } {
  if (!due) return { status: 'info', when: '' };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : localDate(new Date(due), tz);
  if (day < today) return { status: 'bad', when: 'overdue' };
  if (day === today) {
    const timed = !/^\d{4}-\d{2}-\d{2}$/.test(due);
    const t = timed
      ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(due))
      : '';
    return { status: 'warn', when: t ? `today ${t}` : 'today' };
  }
  return { status: 'info', when: day };
}

export async function collectTasks(
  want: { omnifocus: boolean; reminders: 'all' | string[] },
  listNames: Map<string, string>,
  bridges: TaskBridges | null,
  tz: string,
  now = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<Section> {
  const section: Section = { id: 'tasks', kind: 'rows', title: 'Due and overdue' };
  if (!bridges) return { ...section, error: 'no dashboard bridge key (run bridge-policy.ts add-dashboard-key)' };
  const today = localDate(now, tz);
  const rows: Array<Row & { sort: string }> = [];
  const errors: string[] = [];

  if (want.omnifocus && bridges.omnifocusUrl) {
    try {
      const seen = new Set<string>();
      for (const filter of [{ overdue: true }, { dueToday: true }]) {
        const r = (await mcpCall(
          bridges.omnifocusUrl,
          bridges.key,
          'filter_tasks',
          { ...filter, limit: 25 },
          fetchFn,
        )) as {
          tasks?: Array<{ id: string; name: string; dueDate?: string | null; projectName?: string | null }>;
        };
        for (const t of r.tasks ?? []) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          const d = dueRow(t.dueDate, today, tz);
          rows.push({
            title: t.name,
            detail: ['OmniFocus', t.projectName, d.when].filter(Boolean).join(' · '),
            status: d.status,
            time: t.dueDate ?? undefined,
            sort: t.dueDate ?? '9',
          });
        }
      }
    } catch (e) {
      errors.push(`OmniFocus: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  const listFilter = want.reminders === 'all' ? null : new Set(want.reminders.map((id) => listNames.get(id) ?? id));
  if ((want.reminders === 'all' || want.reminders.length) && bridges.remindersUrl) {
    try {
      const r = (await mcpCall(
        bridges.remindersUrl,
        bridges.key,
        'reminders_today',
        { include_overdue: true },
        fetchFn,
      )) as {
        items?: Array<{
          eventKitId?: string;
          title: string;
          list?: string;
          dueDate?: string;
          due?: string;
          completed?: boolean;
        }>;
      };
      for (const it of r.items ?? []) {
        if (it.completed) continue;
        if (listFilter && !listFilter.has(it.list ?? '')) continue;
        const due = it.dueDate ?? it.due;
        const d = dueRow(due, today, tz);
        rows.push({
          title: it.title,
          detail: ['Reminders', it.list, d.when].filter(Boolean).join(' · '),
          status: d.status,
          time: due,
          sort: due ?? '9',
        });
      }
    } catch (e) {
      errors.push(`Reminders: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  rows.sort((a, b) => (a.status === b.status ? a.sort.localeCompare(b.sort) : a.status === 'bad' ? -1 : 1));
  const overdue = rows.filter((r) => r.status === 'bad').length;
  return {
    ...section,
    summary: rows.length ? `${rows.length - overdue} due today${overdue ? `, ${overdue} overdue` : ''}` : 'Nothing due',
    rows: rows.slice(0, 30).map(({ sort: _sort, ...row }) => row),
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}

// ---- Ops -----------------------------------------------------------------------------------

interface GatusStatus {
  name: string;
  group?: string;
  results?: Array<{ success: boolean; timestamp: string }>;
}

export async function collectServices(gatusUrl: string | undefined, fetchFn = fetch): Promise<Section> {
  const section: Section = { id: 'services', kind: 'rows', title: 'Services' };
  if (!gatusUrl) return { ...section, error: 'no Gatus URL configured' };
  const res = await fetchFn(`${gatusUrl}/api/v1/endpoints/statuses?page=1&pageSize=500`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ...section, error: `Gatus ${res.status}` };
  const list = (await res.json()) as GatusStatus[];
  const withResult = list.filter((s) => s.results?.length);
  const failing = withResult.filter((s) => !s.results![s.results!.length - 1]!.success);
  return {
    ...section,
    summary: failing.length
      ? `${withResult.length - failing.length} of ${withResult.length} up`
      : `All ${withResult.length} up`,
    rows: failing
      .map((s) => ({
        title: s.name,
        detail: s.group,
        status: 'bad' as const,
        time: s.results![s.results!.length - 1]!.timestamp,
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

export function collectAlerts(dbFile: string, now = new Date()): Section {
  const section: Section = { id: 'alerts', kind: 'rows', title: 'Alerts, last 24 h' };
  if (!fs.existsSync(dbFile)) return { ...section, error: 'no alerts database' };
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    // gatus-webhook writes ISO-8601 UTC timestamps, so a string comparison is exact.
    const recent = db
      .prepare(
        `SELECT ts, endpoint, grp, status, description, outcome FROM alerts
          WHERE ts >= ? ORDER BY id DESC LIMIT 30`,
      )
      .all(since) as Array<{
      ts: string;
      endpoint: string;
      grp: string | null;
      status: string;
      description: string | null;
      outcome: string;
    }>;
    return {
      ...section,
      summary: recent.length ? `${recent.length} in the last 24 h` : 'None in the last 24 h',
      rows: recent.map((a) => ({
        title: a.endpoint,
        detail: [a.status, a.outcome === 'sent' ? '' : a.outcome, a.description]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 200),
        status: a.status === 'resolved' ? ('ok' as const) : ('bad' as const),
        time: a.ts,
      })),
    };
  } finally {
    db.close();
  }
}

type NclRunner = (args: string[]) => Promise<unknown>;

export function nclRunner(projectRoot: string): NclRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(path.join(projectRoot, 'bin', 'ncl'), [...args, '--json'], {
      cwd: projectRoot,
      timeout: 20_000,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; data?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`ncl ${args.join(' ')} failed`);
    return parsed.data ?? parsed;
  };
}

export async function collectApprovals(ncl: NclRunner): Promise<Section> {
  const section: Section = { id: 'approvals', kind: 'rows', title: 'Pending approvals' };
  const data = (await ncl(['approvals', 'list'])) as Array<Record<string, unknown>>;
  return {
    ...section,
    summary: data.length ? `${data.length} waiting` : 'Nothing waiting',
    rows: data.slice(0, 20).map((a) => ({
      title: String(a.title ?? a.action ?? 'Approval'),
      detail: String(a.action ?? ''),
      status: 'warn' as const,
      time: typeof a.created_at === 'string' ? a.created_at : undefined,
    })),
  };
}

/** "Evening brief. Follow the …" -> "Evening brief" */
export function taskTitle(prompt: string, seriesId?: string): string {
  const first = prompt.split(/[.\n]/)[0]?.trim() ?? '';
  if (first && first.length <= 60) return first;
  if (seriesId) {
    const base = seriesId.replace(/-[0-9a-f]{4}$/, '').replace(/-/g, ' ');
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  return first.slice(0, 57) + '…';
}

export async function collectScheduledTasks(ncl: NclRunner, tz: string): Promise<Section> {
  const section: Section = { id: 'tasks', kind: 'rows', title: 'Scheduled tasks' };
  const [tasks, groups] = (await Promise.all([ncl(['tasks', 'list']), ncl(['groups', 'list'])])) as [
    Array<Record<string, unknown>>,
    Array<{ id: string; name: string }>,
  ];
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const fmt = (iso: unknown) =>
    typeof iso === 'string'
      ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(
          new Date(iso),
        )
      : '—';
  const active = tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'completed');
  return {
    ...section,
    summary: `${active.length} scheduled`,
    rows: active
      .map((t) => {
        const failed = Number(t.failed_runs ?? 0);
        const paused = t.status === 'paused';
        return {
          title: `${names.get(String(t.agent_group_id)) ?? 'agent'} · ${taskTitle(String(t.prompt ?? ''), t.series_id as string | undefined)}`,
          detail: `last ${fmt(t.last_run)} · next ${paused ? 'paused' : fmt(t.next_run ?? t.process_after)}${failed ? ` · ${failed} failed` : ''}`,
          status: (paused ? 'info' : failed ? 'warn' : 'ok') as RowStatus,
          time: typeof t.last_run === 'string' ? t.last_run : undefined,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

// ---- assembly ------------------------------------------------------------------------------

/** Short, human error text: no stack, no command lines. */
export function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/ncl\.sock|cannot reach NanoClaw host/i.test(msg)) return 'NanoClaw host not reachable';
  if (/needs_consent|needs consent/i.test(msg)) return msg.slice(0, 300);
  return msg.split('\n')[0]!.slice(0, 200);
}

async function guard(
  id: string,
  title: string,
  kind: Section['kind'],
  fn: () => Promise<Section> | Section,
): Promise<Section> {
  try {
    return await fn();
  } catch (e) {
    return { id, title, kind, error: friendlyError(e) } as Section;
  }
}

/**
 * A source that fails briefly (host restart, network blip) keeps showing its last good data,
 * marked with the error, instead of going blank.
 */
export function carryOver(section: Section, previous: Section | undefined, previousAt: string | undefined): Section {
  if (!section.error || !previous || previous.error) return section;
  const hasData =
    (previous.kind === 'rows' && previous.rows !== undefined) ||
    (previous.kind === 'events' && previous.days !== undefined) ||
    (previous.kind === 'weather' && previous.weather !== undefined);
  if (!hasData) return section;
  const when = previousAt ? ` (showing data from ${previousAt})` : '';
  return { ...previous, error: `${section.error}${when}` } as Section;
}

export async function buildDashboard(opts: {
  cfg: HomeConfig;
  tz: string;
  reader: CalendarReader;
  ncl: NclRunner;
  alertsDb: string;
  fetchFn?: typeof fetch;
  now?: Date;
  previous?: DashboardFile | null;
  bridges?: TaskBridges | null;
}): Promise<DashboardFile> {
  const d = opts.cfg.dashboard;
  if (!d) throw new Error('home.yaml has no dashboard section');
  const fetchFn = opts.fetchFn ?? fetch;
  const [weather, events, services, approvals, tasks] = await Promise.all([
    guard('weather', 'Weather', 'weather', () => collectWeather(d.weather, fetchFn)),
    guard('events', 'Calendar', 'events', () => collectEvents(opts.cfg, opts.reader, opts.tz, opts.now)),
    guard('services', 'Services', 'rows', () => collectServices(d.gatus_url, fetchFn)),
    guard('approvals', 'Pending approvals', 'rows', () => collectApprovals(opts.ncl)),
    guard('tasks', 'Scheduled tasks', 'rows', () => collectScheduledTasks(opts.ncl, opts.tz)),
  ]);
  const alerts = await guard('alerts', 'Alerts, last 24 h', 'rows', () => collectAlerts(opts.alertsDb, opts.now));
  const listNames = new Map(opts.cfg.reminders.lists.map((l) => [l.id, l.name]));
  // Today is per person: shared weather and calendar, plus that person's own tasks.
  const todayBoards: Board[] = [];
  const shared = d.audience.today.filter((h) => !d.tasks?.[h]);
  if (shared.length) {
    todayBoards.push({
      id: 'today',
      title: 'Today',
      audience: shared,
      sections: d.weather ? [weather, events] : [events],
    });
  }
  for (const handle of d.audience.today.filter((h) => d.tasks?.[h])) {
    const tasks = await guard('tasks', 'Due and overdue', 'rows', () =>
      collectTasks(d.tasks![handle]!, listNames, opts.bridges ?? null, opts.tz, opts.now, fetchFn),
    );
    todayBoards.push({
      id: 'today',
      title: 'Today',
      audience: [handle],
      sections: d.weather ? [weather, tasks, events] : [tasks, events],
    });
  }
  const prev = (board: Board, id: string) =>
    opts.previous?.boards
      .find((b) => b.id === board.id && b.audience.join(',') === board.audience.join(','))
      ?.sections.find((s) => s.id === id);
  const keep = (board: Board): Board => ({
    ...board,
    sections: board.sections.map((s) => carryOver(s, prev(board, s.id), opts.previous?.generatedAt)),
  });
  return {
    version: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    timezone: opts.tz,
    boards: [
      ...todayBoards.map(keep),
      keep({ id: 'ops', title: 'Ops', audience: d.audience.ops, sections: [services, alerts, approvals, tasks] }),
    ],
  };
}

function readBridges(cfg: HomeConfig): TaskBridges | null {
  const file = path.join(os.homedir(), '.config', 'nanoclaw', 'dashboard-bridge.key');
  if (!fs.existsSync(file)) return null;
  return {
    key: fs.readFileSync(file, 'utf8').trim(),
    remindersUrl: cfg.dashboard?.task_bridges?.reminders_url,
    omnifocusUrl: cfg.dashboard?.task_bridges?.omnifocus_url,
  };
}

function readPrevious(file: string): DashboardFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DashboardFile;
  } catch {
    return null;
  }
}

export function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]!) : path.join(root, 'data', 'app-channel', 'dashboard.json');
  const cfg = loadHomeConfig();
  const { TIMEZONE } = await import('../src/config.js');
  const tokens = new GoogleTokens(() => cfg.google_accounts.map((a) => a.id));
  const file = await buildDashboard({
    cfg,
    tz: TIMEZONE,
    reader: new CalendarReader(cfg, tokens),
    ncl: nclRunner(root),
    alertsDb: process.env.ALERTS_DB ?? path.join(os.homedir(), 'nanoclaw-alerts', 'alerts.db'),
    previous: readPrevious(out),
    bridges: readBridges(cfg),
  });
  const json = JSON.stringify(file, null, 2);
  if (args.includes('--print')) console.log(json);
  writeAtomic(out, json);
  const errors = file.boards.flatMap((b) =>
    b.sections.filter((s) => s.error).map((s) => `${b.id}/${s.id}: ${s.error}`),
  );
  console.log(
    `${new Date().toISOString()} dashboard written (${errors.length ? errors.join('; ') : 'all sources ok'})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(`dashboard-feed failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
