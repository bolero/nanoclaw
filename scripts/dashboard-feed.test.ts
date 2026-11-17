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
  collectScheduledTasks,
  collectTasks,
  mcpCall,
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

describe('tasks', () => {
  /** Fake bridge: JSON for OmniFocus (stateless), SSE + session for Reminders (FastMCP style). */
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
      params?: { name: string; arguments: Record<string, unknown> };
    };
    const headers = init.headers as Record<string, string>;
    expect(headers['x-caller-key']).toBe('dash');
    if (String(url).includes('omnifocus')) {
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      const overdue = body.params!.arguments.overdue === true;
      const tasks = overdue
        ? [{ id: 't1', name: 'File taxes', dueDate: '2026-11-10T17:00:00Z', projectName: 'Admin' }]
        : [{ id: 't2', name: 'Call dentist', dueDate: '2026-11-13T18:00:00Z', projectName: null }];
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { content: [{ type: 'text', text: 'x' }], structuredContent: { tasks } },
        }),
      );
    }
    if (body.method === 'initialize')
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
      });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    expect(headers['mcp-session-id']).toBe('s1');
    const items = [
      { eventKitId: 'r1', title: 'Milk', list: 'Family', dueDate: '2026-11-13' },
      { eventKitId: 'r2', title: 'Private thing', list: 'Personal', dueDate: '2026-11-13' },
    ];
    const res = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ items }) }],
        structuredContent: { result: { items } },
      },
    };
    return new Response(`event: message\ndata: ${JSON.stringify(res)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  const bridges = { key: 'dash', remindersUrl: 'https://mac/mcp', omnifocusUrl: 'https://mac:8445/omnifocus/mcp' };
  const names = new Map([['family', 'Family']]);

  it('lists overdue first, then due today, from OmniFocus and only the allowed Reminders lists', async () => {
    const s = await collectTasks(
      { omnifocus: true, reminders: ['family'] },
      names,
      bridges,
      'UTC',
      new Date('2026-11-13T12:00:00Z'),
      fetchFn,
    );
    expect(s).toMatchObject({
      summary: '2 due today, 1 overdue',
      rows: [
        { title: 'File taxes', status: 'bad', detail: 'OmniFocus · Admin · overdue' },
        { title: 'Milk', status: 'warn', detail: 'Reminders · Family · today' },
        { title: 'Call dentist', status: 'warn', detail: 'OmniFocus · today 18:00' },
      ],
    });
  });

  it('shows every list for "all", and explains a missing key', async () => {
    const s = await collectTasks(
      { omnifocus: false, reminders: 'all' },
      names,
      bridges,
      'UTC',
      new Date('2026-11-13T12:00:00Z'),
      fetchFn,
    );
    expect((s as { rows: Array<{ title: string }> }).rows.map((r) => r.title)).toEqual(['Milk', 'Private thing']);
    expect((await collectTasks({ omnifocus: true, reminders: 'all' }, names, null, 'UTC')).error).toMatch(
      /add-dashboard-key/,
    );
  });

  it('surfaces tool errors', async () => {
    const bad = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'This caller is read-only' }] },
        }),
      )) as unknown as typeof fetch;
    await expect(mcpCall('https://x/mcp', 'k', 'edit_item', {}, bad)).rejects.toThrow(/read-only/);
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
    const s = await collectScheduledTasks(ncl, 'UTC');
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

describe('scheduled task outcomes', () => {
  it('reads the latest log entry and flags FAILED / PARTIAL runs', async () => {
    const { lastLogEntry, runOutcome, collectScheduledTasks: collect } = await import('./dashboard-feed.js');
    const log =
      '2026-11-12 06:00 — All good.\n2026-11-13 06:00 — FAILED: the Dockhand proxy blocked the update endpoints.\n';
    expect(lastLogEntry(log)).toBe('FAILED: the Dockhand proxy blocked the update endpoints.');
    expect(runOutcome('**PARTIAL:** calendars missing')?.status).toBe('warn');
    expect(runOutcome('Sent the brief.')).toBeNull();
    const ncl = async (args: string[]) =>
      args[0] === 'tasks'
        ? [
            {
              agent_group_id: 'g1',
              series_id: 'weekly-x',
              prompt: 'Weekly review',
              status: 'pending',
              last_run: '2026-11-13T14:00:00Z',
              log: 'tasks/weekly-x.md',
            },
          ]
        : [{ id: 'g1', name: 'argus', folder: 'argus' }];
    const s = await collect(ncl as never, 'UTC', (folder, p) =>
      folder === 'argus' && p === 'tasks/weekly-x.md' ? log : null,
    );
    expect(s.rows?.[0].status).toBe('bad');
    expect(s.rows?.[0].detail).toMatch(/last run failed: the Dockhand proxy blocked/);
  });
});

describe('local mail review sections', () => {
  it('shows packages for their owner and review health on Ops', async () => {
    const fsm = await import('fs');
    const os = await import('os');
    const pathm = await import('path');
    const { collectPackages, collectMailReview } = await import('./dashboard-feed.js');
    const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'mr-'));
    fsm.writeFileSync(
      pathm.join(dir, 'packages.json'),
      JSON.stringify({
        handle: 'alex',
        packages: [{ from: 'Amazon', item: 'Shoes', carrier: 'UPS', eta: '2026-11-18', status: 'shipped' }],
      }),
    );
    const pk = collectPackages(dir);
    expect(pk.handle).toBe('alex');
    expect(pk.section?.rows?.[0].title).toBe('Shoes · Amazon');
    expect(pk.section?.rows?.[0].detail).toBe('Shipped · UPS · arrives 2026-11-18');
    const now = new Date('2026-11-16T20:00:00Z');
    fsm.writeFileSync(
      pathm.join(dir, 'health.json'),
      JSON.stringify({
        ok: true,
        lastOk: '2026-11-16T19:50:00Z',
        lastRun: '2026-11-16T19:50:00Z',
        reviewedToday: 12,
        packages: 1,
        avgSeconds: 9.5,
        model: 'gemma',
      }),
    );
    expect(collectMailReview(dir, now)?.rows?.[0].status).toBe('ok');
    expect(collectMailReview(dir, new Date('2026-11-17T00:00:00Z'))?.rows?.[0].status).toBe('bad');
    fsm.rmSync(dir, { recursive: true, force: true });
  });
});

describe('suggestion feedback section', () => {
  it('shows the week hit rate and senders with ratings', async () => {
    const { collectFeedback } = await import('./dashboard-feed.js');
    const s = await collectFeedback((async () => ({
      shown: 9,
      useful: 3,
      notUseful: 3,
      hitRate: 0.5,
      itemsTakenUp: 0.75,
      senders: [
        { sender: 'bono', shown: 6, useful: 3, notUseful: 1 },
        { sender: 'Mail review', shown: 2, useful: 0, notUseful: 2 },
        { sender: 'family', shown: 1, useful: 0, notUseful: 0 },
      ],
    })) as never);
    expect(s.kind === 'rows' && s.rows?.map((r) => [r.title, r.status])).toEqual([
      ['3 useful · 3 not useful · hit rate 50%', 'warn'],
      ['bono', 'ok'],
      ['Mail review', 'warn'],
    ]);
  });
});

describe('mail review per person', () => {
  it('shows one Ops row per mailbox and each person only their own packages', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { collectMailReview, mailReviewDirs, collectPackages } = await import('./dashboard-feed.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr2-'));
    const now = new Date('2026-11-16T20:00:00Z');
    for (const h of ['alex', 'sam']) {
      fs.mkdirSync(path.join(root, h));
      fs.writeFileSync(
        path.join(root, h, 'health.json'),
        JSON.stringify({ handle: h, ok: true, lastOk: now.toISOString(), reviewedToday: 3, packages: 1, model: 'm' }),
      );
      fs.writeFileSync(
        path.join(root, h, 'packages.json'),
        JSON.stringify({ handle: h, packages: [{ item: `${h} box`, status: 'shipped' }] }),
      );
    }
    const s = collectMailReview(root, now);
    expect(s?.kind === 'rows' && s.rows?.map((r) => r.title)).toEqual([
      'alex: 3 emails reviewed today · 1 packages',
      'sam: 3 emails reviewed today · 1 packages',
    ]);
    const mine = mailReviewDirs(root)
      .map((d) => collectPackages(d))
      .filter((p) => p.handle === 'sam');
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0].section)).toContain('sam box');
  });
});

describe('event title aliases', () => {
  it('shows configured titles on Today, case-insensitively', async () => {
    const { collectEvents } = await import('./dashboard-feed.js');
    const withAlias = parseHomeConfig(
      `version: 1\nagents: [main]\ngoogle_accounts:\n  - {id: fam, address: fam@example.com, scopes: [calendar.events.owned]}\nmailboxes: []\ncalendars:\n  - {id: family, account: fam, calendar: Family, access: read, used_by: [main]}\nreminders: {unrestricted: [], lists: []}\nomnifocus: {used_by: []}\nnotes: {unrestricted: [], read_all: [], folders: []}\ndestinations: {}\npersonal_watch: []\nschedule: {quiet_hours: "21:00-07:00", brief_time: "19:00", stale_days: 21, nudge_cap: 3}\ndashboard: {audience: {today: [a], ops: [a]}, today_calendars: [family], event_titles: {"Blocked Time": "Work (busy)"}}\n`,
    );
    const now = new Date('2026-11-16T16:00:00Z');
    const ev = (title: string) => ({
      title,
      start: '2026-11-16T18:00:00Z',
      end: '2026-11-16T19:00:00Z',
      allDay: false,
      calendar: 'family',
    });
    const reader = { events: async () => [ev('blocked time'), ev('Ballet')] } as unknown as CalendarReader;
    const s = await collectEvents(withAlias, reader, 'America/Los_Angeles', now);
    const titles = s.kind === 'events' ? s.days!.flatMap((d) => d.events.map((e) => e.title)) : [];
    expect(titles.sort()).toEqual(['Ballet', 'Work (busy)']);
  });
});
