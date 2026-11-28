#!/usr/bin/env bun
/**
 * Follow-ups: every request the agent could not finish in its reply, tracked until it is done.
 * A scheduled task runs `watch` as its pre-task gate, so the agent only wakes when an item finished,
 * failed, needs a manual check, or has waited too long (then the agent follows up with the person).
 *
 *   bun followups.ts add --title <what was asked> --chat <destination> [--for <first name>]
 *                        [--check <bash command>] [--every 15m] [--give-up 2d]
 *       --check prints one JSON line {"state": "done"|"failed"|"pending", "detail"?: "..."} (e.g.
 *       `bun /workspace/agent/tools/seerr.ts check 12`). Without --check the agent is woken every
 *       --every (growing x1.5, at most 6h) to check by hand. --give-up: when to tell the person it
 *       is still not done (then again after the same time).
 *   bun followups.ts list [--all]
 *   bun followups.ts done <id> [--note <text>]        closed by the agent (e.g. after a manual check)
 *   bun followups.ts drop <id>                         the person no longer wants it
 *   bun followups.ts later <id> [--in 1h]              checked by hand, not done yet
 *   bun followups.ts watch                             gate: one line {"wakeAgent": bool, "data": {"items": [...]}}
 *
 * State: $FOLLOWUPS_STATE or /workspace/agent/state/followups.json. Output is JSON.
 */
import fs from 'node:fs';
import path from 'node:path';

type Item = {
  id: number;
  title: string;
  chat: string;
  for?: string;
  check?: string;
  every: number; // minutes
  giveUp: number; // minutes
  created: string;
  next: string;
  giveUpAt: string;
  status: 'open' | 'done' | 'failed' | 'dropped';
  outcome?: string;
  lastError?: string;
};
type State = { nextId: number; items: Item[] };

const MIN = 60_000;
const MAX_EVERY = 360;
const CHECK_TIMEOUT_MS = 8_000;
const CHECK_BUDGET_MS = 20_000;

const fail = (msg: string): never => {
  throw new Error(msg);
};

export function parseArgs(argv: string[]): { pos: string[]; opts: Record<string, string> } {
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && a !== '--check')) fail(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, opts };
}

/** "15m", "2h", "3d" → minutes. */
export function minutes(s: string | undefined, dflt: number): number {
  if (s === undefined) return dflt;
  const m = /^(\d+)\s*([mhd])$/.exec(s.trim());
  if (!m) fail(`bad duration "${s}" (use 15m, 2h or 3d)`);
  return Number(m![1]) * { m: 1, h: 60, d: 1440 }[m![2] as 'm' | 'h' | 'd'];
}

const file = (opts: Record<string, string>) =>
  opts.state ?? process.env.FOLLOWUPS_STATE ?? '/workspace/agent/state/followups.json';

function load(f: string): State {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { nextId: 1, items: [] };
  }
}

function save(f: string, s: State) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // keep closed items for a week, for `list --all`
  const cutoff = Date.now() - 7 * 1440 * MIN;
  s.items = s.items.filter((i) => i.status === 'open' || Date.parse(i.next) > cutoff);
  fs.writeFileSync(f, JSON.stringify(s, null, 1));
}

const iso = (ms: number) => new Date(ms).toISOString();

function view(i: Item, now: number) {
  return {
    id: i.id,
    title: i.title,
    for: i.for,
    chat: i.chat,
    status: i.status,
    waiting: `${Math.round((now - Date.parse(i.created)) / 60 / MIN)}h`,
    outcome: i.outcome,
    nextCheck: i.status === 'open' ? i.next : undefined,
    checkedBy: i.check ? 'script' : 'you',
  };
}

function find(s: State, idArg: string | undefined): Item {
  const id = Number(idArg);
  const it = s.items.find((i) => i.id === id);
  if (!it) fail(`no follow-up #${idArg}`);
  return it!;
}

export type RunCheck = (cmd: string) => { state: string; detail?: string } | { error: string };

export const runCheck: RunCheck = (cmd) => {
  const r = Bun.spawnSync({ cmd: ['bash', '-c', cmd], timeout: CHECK_TIMEOUT_MS, stdout: 'pipe', stderr: 'pipe' });
  const out = r.stdout.toString().trim().split('\n').at(-1) ?? '';
  if (r.exitCode !== 0) return { error: (r.stderr.toString().trim().split('\n').at(-1) || `exit ${r.exitCode}`).slice(0, 200) };
  try {
    const j = JSON.parse(out);
    if (!['done', 'failed', 'pending'].includes(j.state)) return { error: `check printed no state: ${out.slice(0, 120)}` };
    return { state: j.state, detail: j.detail ? String(j.detail).slice(0, 300) : undefined };
  } catch {
    return { error: `check printed no JSON: ${out.slice(0, 120)}` };
  }
};

export async function main(argv: string[], check: RunCheck = runCheck) {
  const { pos, opts } = parseArgs(argv);
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const f = file(opts);
  const s = load(f);
  const [cmd, ...rest] = pos;

  switch (cmd) {
    case 'add': {
      if (!opts.title || !opts.chat) fail('usage: add --title <t> --chat <destination> [--for <name>] [--check <cmd>] [--every 15m] [--give-up 2d]');
      const every = Math.max(minutes(opts.every, 15), 5);
      const giveUp = minutes(opts['give-up'], 2 * 1440);
      const it: Item = {
        id: s.nextId++,
        title: opts.title.slice(0, 200),
        chat: opts.chat,
        for: opts.for,
        check: opts.check,
        every,
        giveUp,
        created: iso(now),
        next: iso(now + every * MIN),
        giveUpAt: iso(now + giveUp * MIN),
        status: 'open',
      };
      s.items.push(it);
      save(f, s);
      return { added: view(it, now) };
    }
    case 'list': {
      const items = s.items.filter((i) => opts.all === 'yes' || i.status === 'open');
      return { followups: items.map((i) => view(i, now)) };
    }
    case 'done':
    case 'drop': {
      const it = find(s, rest[0]);
      it.status = cmd === 'done' ? 'done' : 'dropped';
      it.outcome = opts.note ?? it.outcome;
      it.next = iso(now);
      save(f, s);
      return { closed: view(it, now) };
    }
    case 'later': {
      const it = find(s, rest[0]);
      if (it.status !== 'open') fail(`follow-up #${it.id} is already ${it.status}`);
      it.next = iso(now + minutes(opts.in, it.every) * MIN);
      save(f, s);
      return { next: view(it, now) };
    }
    case 'watch': {
      const started = Date.now();
      const report: any[] = [];
      for (const it of s.items) {
        if (it.status !== 'open') continue;
        if (Date.parse(it.next) <= now) {
          if (it.check && Date.now() - started < CHECK_BUDGET_MS) {
            const r = check(it.check);
            if ('error' in r) it.lastError = r.error;
            else if (r.state === 'done' || r.state === 'failed') {
              it.status = r.state;
              it.outcome = r.detail;
              report.push({ ...view(it, now), kind: r.state, detail: r.detail });
              continue;
            } else it.lastError = undefined;
          } else if (!it.check) {
            report.push({ ...view(it, now), kind: 'check' });
          }
          if (!it.check || Date.now() - started < CHECK_BUDGET_MS) {
            it.every = Math.min(Math.round(it.every * 1.5), MAX_EVERY);
            it.next = iso(now + it.every * MIN);
          }
        }
        if (it.status === 'open' && Date.parse(it.giveUpAt) <= now) {
          report.push({ ...view(it, now), kind: 'overdue', detail: it.lastError ? `last check failed: ${it.lastError}` : undefined });
          it.giveUpAt = iso(now + it.giveUp * MIN);
        }
      }
      save(f, s);
      return { wakeAgent: report.length > 0, data: { items: report } };
    }
    default:
      return fail('usage: add | list | done | drop | later | watch (see the header of followups.ts)');
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((out) => console.log(process.argv[2] === 'watch' ? JSON.stringify(out) : JSON.stringify(out, null, 2)))
    .catch((e) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    });
}
