import { describe, expect, it } from 'bun:test';

import { actionAdd, actionUndo, backlog, brief, filter, open, parseSnooze, reply, stats } from './nudges.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T19:00:00Z');
const opts = { staleDays: 21, cooldownDays: 7, cap: 3 };
const item = (id: string, ageDays: number) => ({
  source: 'reminders',
  id,
  kind: 'stale',
  title: `task ${id}`,
  created: new Date(NOW - ageDays * DAY).toISOString(),
});

describe('nudges', () => {
  it('filters by age and caps; with equal relevance the fresher item comes first', () => {
    const db = open(':memory:');
    const out = filter(db, [item('a', 30), item('b', 5), item('c', 40), item('d', 22), item('e', 60)], opts, NOW);
    expect(out.map((i) => i.id)).toEqual(['d', 'a', 'c']);
  });

  it('ranks by relevance: overdue, flagged, recently edited beat merely old', () => {
    const db = open(':memory:');
    const iso = (d: number) => new Date(NOW + d * DAY).toISOString();
    const out = filter(
      db,
      [
        item('old', 300),
        { ...item('flag', 40), flagged: true },
        { ...item('overdue', 50), due: iso(-3) },
        { ...item('edited', 60), modified: iso(-2) },
      ],
      opts,
      NOW,
    );
    expect(out.map((i) => i.id)).toEqual(['overdue', 'flag', 'edited']);
  });

  it('sinks nudges that were ignored', () => {
    const db = open(':memory:');
    filter(db, [item('a', 30), item('b', 31)], opts, NOW);
    brief(db, ['reminders:a'], NOW - 8 * DAY); // nudged, never answered
    const out = filter(db, [item('a', 30), item('b', 31)], { ...opts, cap: 1 }, NOW);
    expect(out.map((i) => i.id)).toEqual(['b']);
  });

  it('moves year-old untouched items to the backlog and lists them for cleanup', () => {
    const db = open(':memory:');
    const iso = (d: number) => new Date(NOW + d * DAY).toISOString();
    const out = filter(
      db,
      [
        item('ancient', 2000),
        { ...item('ancient-due', 2000), due: iso(5) },
        { ...item('ancient-edited', 2000), modified: iso(-10) },
        item('recent', 40),
      ],
      opts,
      NOW,
    );
    expect(out.map((i) => i.id).sort()).toEqual(['ancient-due', 'ancient-edited', 'recent']);
    const b = backlog(db, 10, NOW);
    expect(b.map((r) => r.id)).toEqual(['ancient']);
    expect(reply(db, 1, 'stop', undefined, NOW).id).toBe('ancient');
    expect(backlog(db, 10, NOW)).toHaveLength(0);
  });

  it('respects cooldown, snooze, drop and done', () => {
    const db = open(':memory:');
    const all = [item('a', 30), item('b', 30), item('c', 30), item('d', 30)];
    filter(db, all, { ...opts, cap: 10 }, NOW);
    brief(db, ['reminders:a', 'reminders:b', 'reminders:c'], NOW);
    expect(reply(db, 1, 'done', undefined, NOW).id).toBe('a');
    expect(reply(db, 2, 'snooze', '2w', NOW).snooze_until).toBe(new Date(NOW + 14 * DAY).toISOString());
    reply(db, 3, 'drop', undefined, NOW);
    // Next day: only d (never nudged) is eligible.
    expect(filter(db, all, { ...opts, cap: 10 }, NOW + DAY).map((i) => i.id)).toEqual(['d']);
    // After 8 days: b is still snoozed; a/c done/dropped.
    expect(filter(db, all, { ...opts, cap: 10 }, NOW + 8 * DAY).map((i) => i.id)).toEqual(['d']);
    // After 15 days: snooze has expired.
    expect(
      filter(db, all, { ...opts, cap: 10 }, NOW + 15 * DAY)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['b', 'd']);
  });

  it('numbers only the latest brief', () => {
    const db = open(':memory:');
    filter(db, [item('a', 30), item('b', 30)], opts, NOW);
    brief(db, ['reminders:a'], NOW);
    brief(db, ['reminders:b'], NOW + DAY);
    expect(reply(db, 1, 'help', undefined, NOW + DAY).id).toBe('b');
    expect(() => reply(db, 2, 'done', undefined, NOW)).toThrow(/no item 2/);
    expect(() => brief(db, ['reminders:zzz'], NOW)).toThrow(/unknown item/);
    expect(() => reply(db, 1, 'explode', undefined, NOW)).toThrow(/verb/);
  });

  it('parses snoozes', () => {
    expect(parseSnooze('3d', NOW)).toBe(new Date(NOW + 3 * DAY).toISOString());
    expect(() => parseSnooze('soon', NOW)).toThrow();
  });

  it('records actions, undo within 7 days only once, and stats', () => {
    const db = open(':memory:');
    const n1 = actionAdd(db, 'omnifocus', 'of1', 'Pay water bill', NOW);
    const n2 = actionAdd(db, 'calendar', 'ev1', 'Dentist', NOW - 8 * DAY);
    expect(actionUndo(db, n1, NOW).id).toBe('of1');
    expect(() => actionUndo(db, n1, NOW)).toThrow(/already/);
    expect(() => actionUndo(db, n2, NOW)).toThrow(/older than 7 days/);
    filter(db, [item('a', 30)], opts, NOW);
    brief(db, ['reminders:a'], NOW);
    reply(db, 1, 'done', undefined, NOW);
    expect(stats(db, 14, NOW)).toEqual({
      days: 14,
      auto_actions: 2,
      undos: 1,
      nudged_items: 1,
      responses: { done: 1 },
    });
  });
});
