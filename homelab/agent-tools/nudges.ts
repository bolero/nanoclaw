#!/usr/bin/env bun
/**
 * Nudge and action record for a proactive assistant (runs inside the agent container with Bun).
 *
 *   bun nudges.ts filter [--stale-days 21] [--cooldown-days 7] [--cap 3] [--backlog-days 365] < items.json
 *       items.json: [{"source":"omnifocus|reminders","id":"…","kind":"stale","title":"…","created":"ISO",
 *                     "due":"ISO?","flagged":bool?,"priority":"high|medium|low?","project":"…?","modified":"ISO?"}]
 *       Records every item as seen and prints the ones eligible for a nudge (old enough, not
 *       snoozed, dropped/stopped/done, not nudged within the cooldown, not backlog), most relevant
 *       first (due/overdue, flagged, priority, recently edited, in a project; ignored nudges sink),
 *       at most --cap. Backlog = older than --backlog-days with no due date and no edit in 90 days.
 *   bun nudges.ts backlog [--backlog-days 365] [--limit 10]
 *       Lists backlog items (oldest first) for an occasional cleanup session, numbered like a brief.
 *   bun nudges.ts brief <source:id> [<source:id> …]
 *       Numbers the listed items 1..n for replies ("done 2") and marks them nudged now.
 *   bun nudges.ts reply <n> done|drop|stop|help|snooze <3d|1w|2026-12-01>   (stop = never suggest again)
 *       Resolves number n from the last brief, records the response, prints the item as JSON.
 *   bun nudges.ts action add <source> <id> <title>       -> prints the undo number N
 *   bun nudges.ts action undo <N>                          -> prints the action as JSON, marks it undone
 *   bun nudges.ts stats [--days 14]
 *
 * DB: $NUDGES_DB or /workspace/agent/state/nudges.db
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;

export function open(file = process.env.NUDGES_DB ?? '/workspace/agent/state/nudges.db'): Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      key TEXT PRIMARY KEY, source TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      created TEXT, first_seen TEXT NOT NULL, last_nudged TEXT, times_nudged INTEGER NOT NULL DEFAULT 0,
      response TEXT, responded_at TEXT, snooze_until TEXT, number_in_last_brief INTEGER
    );
    CREATE TABLE IF NOT EXISTS actions (
      n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, item_id TEXT NOT NULL,
      title TEXT NOT NULL, undone_at TEXT
    );
  `);
  return db;
}

interface Item {
  source: string;
  id: string;
  kind?: string;
  title: string;
  created?: string;
  due?: string;
  flagged?: boolean;
  priority?: string;
  project?: string;
  modified?: string;
}

/** Relevance of a stale item right now: higher = more worth a nudge. */
export function score(it: Item, timesIgnored: number, now: number): number {
  let s = 0;
  const due = it.due ? Date.parse(it.due) : NaN;
  if (!isNaN(due)) {
    const days = (due - now) / DAY;
    if (days < 0)
      s += 40 + Math.min(10, -days / 7); // overdue
    else if (days <= 7)
      s += 35 - days * 2; // due this week
    else if (days <= 30) s += 15;
  }
  if (it.flagged) s += 20;
  if (it.priority === 'high') s += 15;
  else if (it.priority === 'medium') s += 5;
  const mod = it.modified ? Date.parse(it.modified) : NaN;
  if (!isNaN(mod) && now - mod < 30 * DAY) s += 15;
  if (it.project) s += 8;
  return s - 10 * Math.min(timesIgnored, 4);
}

export function isBacklog(it: Item, created: number, now: number, backlogDays: number): boolean {
  if (it.due) return false;
  const mod = it.modified ? Date.parse(it.modified) : NaN;
  if (!isNaN(mod) && now - mod < 90 * DAY) return false;
  return now - created >= backlogDays * DAY;
}

const clean = (s: unknown, max = 200): string =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max);

export function parseSnooze(spec: string, now: number): string {
  const m = spec.match(/^(\d{1,3})([dw])$/);
  if (m) return new Date(now + Number(m[1]) * (m[2] === 'w' ? 7 : 1) * DAY).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec) && !isNaN(Date.parse(spec))) return new Date(`${spec}T07:00:00`).toISOString();
  throw new Error('snooze needs 3d, 2w or YYYY-MM-DD');
}

export function filter(
  db: Database,
  items: Item[],
  opts: { staleDays: number; cooldownDays: number; cap: number; backlogDays?: number },
  now = Date.now(),
): Item[] {
  const backlogDays = opts.backlogDays ?? 365;
  const iso = new Date(now).toISOString();
  const upsert = db.prepare(
    `INSERT INTO items (key, source, item_id, kind, title, created, first_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, created = COALESCE(excluded.created, items.created)`,
  );
  const get = db.prepare(`SELECT * FROM items WHERE key = ?1`);
  const eligible: (Item & { age: number; score: number })[] = [];
  for (const it of items) {
    if (!it || typeof it.source !== 'string' || typeof it.id !== 'string') continue;
    const key = `${clean(it.source, 20)}:${clean(it.id, 200)}`;
    upsert.run(
      key,
      clean(it.source, 20),
      clean(it.id, 200),
      clean(it.kind ?? 'stale', 20),
      clean(it.title),
      it.created ?? null,
      iso,
    );
    const row = get.get(key) as Record<string, string | number | null>;
    const created = Date.parse(String(row.created ?? row.first_seen));
    if (now - created < opts.staleDays * DAY) continue;
    if (row.response === 'drop' || row.response === 'done' || row.response === 'stop') continue;
    if (row.snooze_until && Date.parse(String(row.snooze_until)) > now) continue;
    if (row.last_nudged && now - Date.parse(String(row.last_nudged)) < opts.cooldownDays * DAY) continue;
    if (isBacklog(it, created, now, backlogDays)) {
      db.prepare(`UPDATE items SET kind = 'backlog' WHERE key = ?1`).run(key);
      continue;
    }
    if (row.kind === 'backlog')
      db.prepare(`UPDATE items SET kind = ?1 WHERE key = ?2`).run(clean(it.kind ?? 'stale', 20), key);
    // A nudge that got no reply counts as ignored.
    const ignored = Number(row.times_nudged ?? 0) - (row.responded_at ? 1 : 0);
    eligible.push({ ...it, title: clean(it.title), age: now - created, score: score(it, Math.max(0, ignored), now) });
  }
  return eligible
    .sort((a, b) => b.score - a.score || a.age - b.age)
    .slice(0, opts.cap)
    .map(({ age: _age, score: _score, ...rest }) => rest);
}

/** Backlog items for a cleanup session, oldest first; numbers them like a brief so replies work. */
export function backlog(db: Database, limit: number, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT key, source, item_id, title, created, first_seen FROM items
       WHERE kind = 'backlog' AND (response IS NULL OR response IN ('help','snooze'))
         AND (snooze_until IS NULL OR snooze_until < ?1)
       ORDER BY COALESCE(created, first_seen) LIMIT ?2`,
    )
    .all(new Date(now).toISOString(), limit) as Record<string, string>[];
  brief(
    db,
    rows.map((r) => r.key),
    now,
  );
  return rows.map((r, i) => ({
    n: i + 1,
    source: r.source,
    id: r.item_id,
    title: r.title,
    created: r.created ?? r.first_seen,
  }));
}

export function brief(db: Database, keys: string[], now = Date.now()): void {
  const iso = new Date(now).toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE items SET number_in_last_brief = NULL`).run();
    keys.forEach((k, i) => {
      const r = db
        .prepare(
          `UPDATE items SET number_in_last_brief = ?1, last_nudged = ?2, times_nudged = times_nudged + 1,
           response = NULL WHERE key = ?3`,
        )
        .run(i + 1, iso, k);
      if (r.changes !== 1) throw new Error(`unknown item ${k} (run filter first)`);
    });
  })();
}

export function reply(db: Database, n: number, verb: string, arg: string | undefined, now = Date.now()) {
  const row = db.prepare(`SELECT * FROM items WHERE number_in_last_brief = ?1`).get(n) as Record<
    string,
    unknown
  > | null;
  if (!row) throw new Error(`no item ${n} in the last brief`);
  if (!['done', 'drop', 'stop', 'help', 'snooze'].includes(verb))
    throw new Error('reply verb must be done, drop, stop, help or snooze');
  const snooze = verb === 'snooze' ? parseSnooze(arg ?? '', now) : null;
  db.prepare(
    `UPDATE items SET response = ?1, responded_at = ?2, snooze_until = COALESCE(?3, snooze_until) WHERE key = ?4`,
  ).run(verb, new Date(now).toISOString(), snooze, row.key as string);
  return { n, verb, snooze_until: snooze, source: row.source, id: row.item_id, title: row.title };
}

export function actionAdd(db: Database, source: string, id: string, title: string, now = Date.now()): number {
  const r = db
    .prepare(`INSERT INTO actions (at, source, item_id, title) VALUES (?1, ?2, ?3, ?4)`)
    .run(new Date(now).toISOString(), clean(source, 20), clean(id, 300), clean(title));
  return Number(r.lastInsertRowid);
}

export function actionUndo(db: Database, n: number, now = Date.now()) {
  const row = db.prepare(`SELECT * FROM actions WHERE n = ?1`).get(n) as Record<string, unknown> | null;
  if (!row) throw new Error(`no action ${n}`);
  if (row.undone_at) throw new Error(`action ${n} was already undone`);
  if (now - Date.parse(String(row.at)) > 7 * DAY) throw new Error(`action ${n} is older than 7 days; undo it by hand`);
  db.prepare(`UPDATE actions SET undone_at = ?1 WHERE n = ?2`).run(new Date(now).toISOString(), n);
  return { n, source: row.source, id: row.item_id, title: row.title };
}

export function stats(db: Database, days: number, now = Date.now()) {
  const since = new Date(now - days * DAY).toISOString();
  const one = (sql: string) => (db.prepare(sql).get(since) as { c: number }).c;
  return {
    days,
    auto_actions: one(`SELECT COUNT(*) c FROM actions WHERE at >= ?1`),
    undos: one(`SELECT COUNT(*) c FROM actions WHERE undone_at >= ?1`),
    nudged_items: one(`SELECT COUNT(*) c FROM items WHERE last_nudged >= ?1`),
    responses: Object.fromEntries(
      (
        db.prepare(`SELECT response, COUNT(*) c FROM items WHERE responded_at >= ?1 GROUP BY response`).all(since) as {
          response: string;
          c: number;
        }[]
      ).map((r) => [r.response, r.c]),
    ),
  };
}

function flagNum(args: string[], name: string, dflt: number): number {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = open();
  try {
    if (cmd === 'filter') {
      const items = JSON.parse(await Bun.stdin.text()) as Item[];
      if (!Array.isArray(items)) throw new Error('stdin must be a JSON array');
      const out = filter(db, items, {
        staleDays: flagNum(rest, '--stale-days', 21),
        cooldownDays: flagNum(rest, '--cooldown-days', 7),
        cap: flagNum(rest, '--cap', 3),
        backlogDays: flagNum(rest, '--backlog-days', 365),
      });
      console.log(JSON.stringify(out.map((i) => ({ key: `${i.source}:${i.id}`, ...i }))));
    } else if (cmd === 'backlog') {
      console.log(JSON.stringify(backlog(db, flagNum(rest, '--limit', 10))));
    } else if (cmd === 'brief') {
      brief(db, rest);
      console.log(`numbered ${rest.length} item(s)`);
    } else if (cmd === 'reply') {
      console.log(JSON.stringify(reply(db, Number(rest[0]), rest[1], rest[2])));
    } else if (cmd === 'action' && rest[0] === 'add') {
      console.log(actionAdd(db, rest[1], rest[2], rest.slice(3).join(' ')));
    } else if (cmd === 'action' && rest[0] === 'undo') {
      console.log(JSON.stringify(actionUndo(db, Number(rest[1]))));
    } else if (cmd === 'stats') {
      console.log(JSON.stringify(stats(db, flagNum(rest, '--days', 14)), null, 2));
    } else {
      console.error('usage: nudges.ts filter|backlog|brief|reply|action add|action undo|stats (see header)');
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
