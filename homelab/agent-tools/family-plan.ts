#!/usr/bin/env bun
/**
 * Family plan: meals by day and kids' activities with who drops off and picks up. Kept by the
 * family agent as one small JSON file that the app's Today board reads (meals, activities & driving).
 *
 *   bun family-plan.ts show [--days 7]                       plan from today, as JSON
 *   bun family-plan.ts meal set <YYYY-MM-DD> <breakfast|lunch|dinner|snack> <text>
 *   bun family-plan.ts meal clear <YYYY-MM-DD> [meal]
 *   bun family-plan.ts drive add <YYYY-MM-DD> <HH:MM|-> <title> [--who <kid>] [--note <text>]   -> prints the id
 *   bun family-plan.ts drive set <id> [--drop <name|none|n/a>] [--pickup <name|none|n/a>] [--note <text>] [--time HH:MM]
 *       (n/a = that leg isn't needed, e.g. pickup-only; none = unassigned, shows "needs a driver")
 *   bun family-plan.ts drive remove <id>
 *   bun family-plan.ts drive open [--days 2]                  drives still missing a driver
 *
 * File: $FAMILY_PLAN or /workspace/agent/state/plan.json. Entries older than 14 days are dropped
 * on every write. Text is plain (no Markdown) and capped; the board shows it as is.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'] as const;
export type Meal = (typeof MEALS)[number];

export interface Drive {
  id: string;
  date: string;
  time?: string;
  title: string;
  who?: string;
  drop?: string | null;
  pickup?: string | null;
  note?: string;
}

export interface Plan {
  version: 1;
  meals: Record<string, Partial<Record<Meal, string>>>;
  drives: Drive[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEEP_DAYS = 14;

export const empty = (): Plan => ({ version: 1, meals: {}, drives: [] });

const text = (s: string, max: number, what: string): string => {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) throw new Error(`${what} is empty`);
  return t.slice(0, max);
};
const date = (s: string): string => {
  if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`bad date "${s}" (YYYY-MM-DD)`);
  return s;
};
const time = (s: string): string | undefined => {
  if (s === '-' || s === '') return undefined;
  if (!TIME.test(s)) throw new Error(`bad time "${s}" (HH:MM, 24-hour, or -)`);
  return s;
};

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function load(file: string): Plan {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Plan>;
    return { version: 1, meals: p.meals ?? {}, drives: Array.isArray(p.drives) ? p.drives : [] };
  } catch {
    return empty();
  }
}

export function save(file: string, plan: Plan, today: string): void {
  const cutoff = addDays(today, -KEEP_DAYS);
  const pruned: Plan = {
    version: 1,
    meals: Object.fromEntries(Object.entries(plan.meals).filter(([d, m]) => d >= cutoff && Object.keys(m).length)),
    drives: plan.drives.filter((x) => x.date >= cutoff),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pruned, null, 1));
  fs.renameSync(tmp, file);
}

export function setMeal(plan: Plan, d: string, meal: string, value: string): void {
  if (!(MEALS as readonly string[]).includes(meal)) throw new Error(`meal must be one of ${MEALS.join(', ')}`);
  (plan.meals[date(d)] ??= {})[meal as Meal] = text(value, 120, 'meal');
}

export function clearMeal(plan: Plan, d: string, meal?: string): void {
  const day = plan.meals[date(d)];
  if (!day) return;
  if (meal) delete day[meal as Meal];
  else delete plan.meals[d];
}

export function addDrive(
  plan: Plan,
  d: string,
  t: string,
  title: string,
  opts: { who?: string; note?: string } = {},
): Drive {
  const drive: Drive = { id: '', date: date(d), title: text(title, 80, 'title'), drop: null, pickup: null };
  const tm = time(t);
  if (tm) drive.time = tm;
  if (opts.who) drive.who = text(opts.who, 30, 'who');
  if (opts.note) drive.note = text(opts.note, 120, 'note');
  // Same activity on the same day and time is the same drive: return it instead of duplicating.
  const same = plan.drives.find(
    (x) =>
      x.date === drive.date &&
      (x.time ?? '') === (drive.time ?? '') &&
      x.title.toLowerCase() === drive.title.toLowerCase(),
  );
  if (same) return same;
  let n = plan.drives.length + 1;
  const ids = new Set(plan.drives.map((x) => x.id));
  while (ids.has(`d${n}`)) n++;
  drive.id = `d${n}`;
  plan.drives.push(drive);
  return drive;
}

export function setDrive(
  plan: Plan,
  id: string,
  opts: { drop?: string; pickup?: string; note?: string; time?: string },
): Drive {
  const x = plan.drives.find((d) => d.id === id);
  if (!x) throw new Error(`no drive "${id}"`);
  const who = (v: string) => {
    const k = v.trim().toLowerCase();
    return k === 'none' ? null : k === 'n/a' ? 'n/a' : text(v, 30, 'driver');
  };
  if (opts.drop !== undefined) x.drop = who(opts.drop);
  if (opts.pickup !== undefined) x.pickup = who(opts.pickup);
  if (opts.note !== undefined) x.note = opts.note ? text(opts.note, 120, 'note') : undefined;
  if (opts.time !== undefined) x.time = time(opts.time);
  return x;
}

export function openDrives(plan: Plan, today: string, days: number): Drive[] {
  const last = addDays(today, days - 1);
  return plan.drives
    .filter((x) => x.date >= today && x.date <= last && (!x.drop || !x.pickup))
    .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
}

export function window(plan: Plan, today: string, days: number): Plan {
  const last = addDays(today, days - 1);
  return {
    version: 1,
    meals: Object.fromEntries(Object.entries(plan.meals).filter(([d]) => d >= today && d <= last)),
    drives: plan.drives.filter((x) => x.date >= today && x.date <= last),
  };
}

function flags(args: string[]): { rest: string[]; f: Record<string, string> } {
  const rest: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) f[args[i].slice(2)] = args[++i] ?? '';
    else rest.push(args[i]);
  }
  return { rest, f };
}

function localToday(): string {
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

export function main(argv: string[], file: string, today: string): string {
  const { rest, f } = flags(argv);
  const [cmd, sub, ...args] = rest;
  const plan = load(file);
  const days = Number(f.days ?? 7);
  if (cmd === 'show') return JSON.stringify(window(plan, today, days), null, 1);
  if (cmd === 'meal' && sub === 'set') {
    setMeal(plan, args[0], args[1], args.slice(2).join(' '));
  } else if (cmd === 'meal' && sub === 'clear') {
    clearMeal(plan, args[0], args[1]);
  } else if (cmd === 'drive' && sub === 'add') {
    const d = addDrive(plan, args[0], args[1], args.slice(2).join(' '), { who: f.who, note: f.note });
    save(file, plan, today);
    return d.id;
  } else if (cmd === 'drive' && sub === 'set') {
    const d = setDrive(plan, args[0], { drop: f.drop, pickup: f.pickup, note: f.note, time: f.time });
    save(file, plan, today);
    return JSON.stringify(d);
  } else if (cmd === 'drive' && sub === 'remove') {
    plan.drives = plan.drives.filter((x) => x.id !== args[0]);
  } else if (cmd === 'drive' && sub === 'open') {
    return JSON.stringify(openDrives(plan, today, Number(f.days ?? 2)), null, 1);
  } else {
    throw new Error('usage: see the header of family-plan.ts');
  }
  save(file, plan, today);
  return 'ok';
}

if (import.meta.main) {
  try {
    console.log(
      main(process.argv.slice(2), process.env.FAMILY_PLAN ?? '/workspace/agent/state/plan.json', localToday()),
    );
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
