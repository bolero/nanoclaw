import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  bucketEvents,
  buildDashboard,
  CalendarReader,
  collectAlerts,
  collectServices,
  collectTasks,
  collectWeather,
  nwsCode,
  localDate,
  localMidnight,
  friendlyError,
  taskTitle,
  type DashEvent,
} from './dashboard-feed.js';
import { parseHomeConfig } from './home-config.js';

const cfg = parseHomeConfig(`
version: 1
agents: [main]
google_accounts:
  - {id: fam, address: fam@example.com, scopes: [calendar.events.owned, calendar.calendarlist.readonly]}
mailboxes: []
calendars:
  - {id: family, account: fam, calendar: Family, access: write, used_by: [main]}
reminders: {unrestricted: [], lists: []}
omnifocus: {used_by: []}
notes: {unrestricted: [], read_all: [], folders: []}
destinations: {}
personal_watch: []
schedule: {quiet_hours: "21:00-07:00", brief_time: "19:00", stale_days: 21, nudge_cap: 3}
dashboard:
  audience: {today: [alex], ops: [alex]}
  today_calendars: [family]
  gatus_url: https://status.example.com/
`);

describe('dashboard config', () => {
  it('parses the optional dashboard section and rejects unknown calendars', () => {
    expect(cfg.dashboard).toEqual({
      audience: { today: ['alex'], ops: ['alex'] },
      today_calendars: ['family'],
      gatus_url: 'https://status.example.com',
    });
    expect(() =>
      parseHomeConfig(
        `version: 1\nagents: [main]\ngoogle_accounts: []\nmailboxes: []\ncalendars: []\nreminders: {unrestricted: [], lists: []}\nomnifocus: {used_by: []}\nnotes: {unrestricted: [], read_all: [], folders: []}\ndestinations: {}\npersonal_watch: []\nschedule: {quiet_hours: "21:00-07:00", brief_time: "19:00", stale_days: 21, nudge_cap: 3}\ndashboard: {audience: {today: [a], ops: [a]}, today_calendars: [nope]}\n`,
      ),
    ).toThrow(/unknown calendar "nope"/);
  });
});

describe('time helpers', () => {
  it('finds local midnight across zones and DST', () => {
    expect(localMidnight('2026-11-13', 'America/Los_Angeles').toISOString()).toBe('2026-11-13T08:00:00.000Z');
    expect(localMidnight('2026-07-01', 'America/Los_Angeles').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(localMidnight('2026-03-29', 'Europe/Amsterdam').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(localDate(new Date('2026-11-14T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-13');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('Today', () => {
  it('buckets timed and multi-day all-day events by local day', () => {
    const ev = (title: string, start: string, end: string, allDay = false): DashEvent => ({
      title,
      start,
      end,
      allDay,
      calendar: 'family',
    });
    const days = bucketEvents(
      [
        ev('Late dinner', '2026-11-14T03:30:00Z', '2026-11-14T05:00:00Z'), // 19:30 on the 13th in LA
        ev('School trip', '2026-11-14', '2026-11-16', true),
        ev('Dentist', '2026-11-14T17:00:00Z', '2026-11-14T18:00:00Z'),
      ],
      '2026-11-13',
      'America/Los_Angeles',
    );
    expect(days[0]).toMatchObject({ label: 'Today', events: [{ title: 'Late dinner' }] });
    expect(days[1]!.label).toBe('Tomorrow');
    expect(days[1]!.events.map((e) => e.title)).toEqual(['School trip', 'Dentist']);
    expect(days[2]!.events.map((e) => e.title)).toEqual(['School trip']);
    expect(days).toHaveLength(7);
  });

  it('reads a named calendar through the account read scope', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('calendarList')) {
        return new Response(JSON.stringify({ items: [{ id: 'fam123@group', summary: 'Family' }] }));
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              summary: 'Concert',
              start: { dateTime: '2026-11-19T02:00:00Z' },
              end: { dateTime: '2026-11-19T03:00:00Z' },
            },
            { status: 'cancelled' },
          ],
        }),
      );
    }) as typeof fetch;
    const scopes: string[] = [];
    const reader = new CalendarReader(cfg, { token: async (_a, s) => (scopes.push(s), 't') }, fetchFn);
    const events = await reader.events('family', new Date('2026-11-13T08:00:00Z'), new Date('2026-11-20T08:00:00Z'));
    expect(events).toEqual([
      {
        title: 'Concert',
        start: '2026-11-19T02:00:00Z',
        end: '2026-11-19T03:00:00Z',
        allDay: false,
        calendar: 'family',
      },
    ]);
    expect(scopes).toEqual(['calendar.calendarlist.readonly', 'calendar.events.owned']);
    expect(calls[1]).toContain('fam123%40group');
  });
});

describe('weather', () => {
  it('reads the US National Weather Service when configured', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(String(url));
      if (String(url).includes('/points/'))
        return new Response(
          JSON.stringify({ properties: { forecast: 'https://nws/f', forecastHourly: 'https://nws/h' } }),
        );
      if (String(url).startsWith('https://nws/h'))
        return new Response(
          JSON.stringify({
            properties: {
              periods: [{ temperature: 61, temperatureUnit: 'F', shortForecast: 'Partly Cloudy', isDaytime: false }],
            },
          }),
        );
      return new Response(
        JSON.stringify({
          properties: {
            periods: [
              { temperature: 52, temperatureUnit: 'F', shortForecast: 'Clear', isDaytime: false },
              { temperature: 70, temperatureUnit: 'F', shortForecast: 'Sunny', isDaytime: true },
            ],
          },
        }),
      );
    }) as typeof fetch;
    const s = await collectWeather(
      { latitude: 37.39, longitude: -121.89, label: 'Home', unit: 'fahrenheit', provider: 'nws' },
      fetchFn,
    );
    expect(s).toMatchObject({
      weather: { temperature: 61, text: 'Partly Cloudy', code: 2, high: 70, low: 52, unit: '°F' },
    });
    expect(seen[0]).toBe('https://api.weather.gov/points/37.3900,-121.8900');
    expect(nwsCode('Chance Rain Showers')).toBe(63);
  });
});

describe('Ops', () => {
  it('lists only failing services with an up count', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify([
          {
            name: 'Plex',
            group: 'Media',
            results: [
              { success: true, timestamp: 't1' },
              { success: false, timestamp: 't2' },
            ],
          },
          { name: 'Docs', group: 'Apps', results: [{ success: true, timestamp: 't3' }] },
          { name: 'New', results: [] },
        ]),
      )) as unknown as typeof fetch;
    const s = await collectServices('https://status.example.com', fetchFn);
    expect(s).toMatchObject({
      summary: '1 of 2 up',
      rows: [{ title: 'Plex', detail: 'Media', status: 'bad', time: 't2' }],
    });
  });

  it('reads recent alerts read-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-alerts-'));
    const file = path.join(dir, 'alerts.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, endpoint TEXT NOT NULL, grp TEXT,
      status TEXT NOT NULL, description TEXT, url TEXT, outcome TEXT NOT NULL)`);
    const ins = db.prepare('INSERT INTO alerts (ts, endpoint, status, outcome) VALUES (?, ?, ?, ?)');
    ins.run('2026-11-12T01:00:00.000Z', 'old', 'triggered', 'sent');
    ins.run('2026-11-13T10:00:00.000Z', 'plex', 'triggered', 'sent');
    ins.run('2026-11-13T11:00:00.000Z', 'plex', 'resolved', 'suppressed');
    db.close();
    const s = collectAlerts(file, new Date('2026-11-13T12:00:00Z'));
    expect(s).toMatchObject({
      summary: '2 in the last 24 h',
      rows: [
        { title: 'plex', status: 'ok', detail: 'resolved · suppressed' },
        { title: 'plex', status: 'bad', detail: 'triggered' },
      ],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names tasks from their prompt and flags failures', async () => {
    expect(taskTitle('Evening brief. Follow the section…')).toBe('Evening brief');
    expect(taskTitle('x'.repeat(80), 'weekly-docker-update-rev-b67e')).toBe('Weekly docker update rev');
    const ncl = async (args: string[]) =>
      args[0] === 'groups'
        ? [{ id: 'g1', name: 'argus' }]
        : [
            {
              agent_group_id: 'g1',
              prompt: 'Nightly check.',
              status: 'pending',
              last_run: '2026-11-13T10:00:00Z',
              next_run: '2026-11-14T10:00:00Z',
              failed_runs: 2,
            },
            { agent_group_id: 'g1', prompt: 'Old one.', status: 'cancelled' },
          ];
    const s = await collectTasks(ncl, 'UTC');
    expect(s).toMatchObject({ summary: '1 scheduled', rows: [{ title: 'argus · Nightly check', status: 'warn' }] });
    expect((s as { rows: Array<{ detail: string }> }).rows[0]!.detail).toContain('2 failed');
  });
});

describe('friendlyError', () => {
  it('turns ncl socket failures into one short line', () => {
    expect(
      friendlyError(
        new Error(
          'Command failed: /x/bin/ncl tasks list --json\nncl: cannot reach NanoClaw host (connect ENOENT /x/data/ncl.sock).',
        ),
      ),
    ).toBe('NanoClaw host not reachable');
    expect(friendlyError(new Error('Gatus 503\nmore'))).toBe('Gatus 503');
  });
});

describe('buildDashboard', () => {
  it('keeps a board when one source fails and carries the audience', async () => {
    const reader = { events: async () => [] } as unknown as CalendarReader;
    const fetchFn = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const ncl = async () => {
      throw new Error('host down');
    };
    const out = await buildDashboard({
      cfg,
      tz: 'UTC',
      reader,
      ncl,
      alertsDb: '/nonexistent',
      fetchFn,
      now: new Date('2026-11-13T12:00:00Z'),
    });
    expect(out.boards.map((b) => [b.id, b.audience])).toEqual([
      ['today', ['alex']],
      ['ops', ['alex']],
    ]);
    const ops = out.boards[1]!.sections;
    expect(ops.find((s) => s.id === 'services')!.error).toBe('Gatus 503');
    expect(ops.find((s) => s.id === 'approvals')!.error).toBe('host down');

    // Next run with the same failures keeps the last good data, marked with the error.
    const good = structuredClone(out);
    const tasksSection = good.boards[1]!.sections.find((s) => s.id === 'tasks')!;
    Object.assign(tasksSection, {
      error: undefined,
      summary: '1 scheduled',
      rows: [{ title: 'argus · Nightly check' }],
    });
    const again = await buildDashboard({
      cfg,
      tz: 'UTC',
      reader,
      ncl,
      alertsDb: '/nonexistent',
      fetchFn,
      previous: good,
    });
    expect(again.boards[1]!.sections.find((s) => s.id === 'tasks')).toMatchObject({
      rows: [{ title: 'argus · Nightly check' }],
      error: 'host down (showing data from 2026-11-13T12:00:00.000Z)',
    });
    expect(ops.find((s) => s.id === 'alerts')!.error).toBe('no alerts database');
    expect(out.boards[0]!.sections.map((s) => s.id)).toEqual(['events']);
  });
});
