/**
 * Loader + validator for the private home-assistant config (~/.config/nanoclaw/home.yaml).
 * Example: homelab/home.example.yaml. Used by the host-side brokers (google-broker, bridges)
 * to enforce `used_by` per caller. Strict: unknown keys, dangling references and malformed
 * values are errors, so a typo never silently widens or narrows access.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';

export type Access = 'none' | 'read' | 'write';
export type UsedBy = { agent: string; readOnly: boolean }[];

export interface GoogleAccount {
  id: string;
  address: string;
  scopes: string[];
}
/** Gemini on Vertex AI for `triaged` mailboxes (see scripts/mail-triage.ts). */
export interface TriageConfig {
  /** Gmail query for the non-starred mail worth triaging, e.g. "category:primary -category:promotions". */
  query: string;
  project: string;
  region: string;
  model: string;
}
export interface Mailbox {
  id: string;
  account: string;
  /**
   * starred: only STARRED messages. triaged: starred messages as with `starred` (trusted), plus
   * non-starred mail matching triage.query, which the agent sees only as Gemini-derived summaries.
   * allowlisted-forwarders: only mail from a verified allowlisted forwarder.
   */
  mode: 'starred' | 'triaged' | 'allowlisted-forwarders';
  forwarders: string[];
  triage?: TriageConfig;
  used_by: UsedBy;
}
export interface Calendar {
  id: string;
  account: string;
  calendar: string;
  access: 'read' | 'write';
  used_by: UsedBy;
}
export interface NamedItem {
  id: string;
  name: string;
  used_by: UsedBy;
}
export interface Destination {
  list?: string;
  calendar?: string;
}
export interface HomeConfig {
  version: 1;
  agents: string[];
  google_accounts: GoogleAccount[];
  mailboxes: Mailbox[];
  calendars: Calendar[];
  reminders: { unrestricted: string[]; lists: NamedItem[] };
  omnifocus: { used_by: UsedBy };
  /** read_all: agents that read every folder but write only in folders they are used_by (not :read). */
  notes: { unrestricted: string[]; read_all: string[]; folders: NamedItem[] };
  destinations: Record<string, Destination>;
  personal_watch: ('omnifocus' | 'reminders')[];
  schedule: {
    quiet_hours: { start: string; end: string };
    brief_time: string;
    stale_days: number;
    nudge_cap: number;
  };
}

export const DEFAULT_HOME_CONFIG_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'home.yaml');

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const SCOPES = new Set([
  'gmail.readonly',
  'calendar.readonly',
  'calendar.events.owned',
  'calendar.calendarlist.readonly',
  'calendar.calendars.readonly',
]);
/** Destination list ids that are not Reminders lists. */
const SPECIAL_LISTS = new Set(['omnifocus-inbox']);

export class HomeConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`home config invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'HomeConfigError';
  }
}

type Obj = Record<string, unknown>;

class V {
  problems: string[] = [];
  err(where: string, msg: string): void {
    this.problems.push(`${where}: ${msg}`);
  }
  obj(v: unknown, where: string, allowed: string[], required: string[] = allowed): Obj {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      this.err(where, 'must be a mapping');
      return {};
    }
    const o = v as Obj;
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.err(where, `unknown key "${k}"`);
    for (const k of required) if (!(k in o)) this.err(where, `missing "${k}"`);
    return o;
  }
  arr(v: unknown, where: string): unknown[] {
    if (!Array.isArray(v)) {
      this.err(where, 'must be a list');
      return [];
    }
    return v;
  }
  str(v: unknown, where: string, re?: RegExp): string {
    if (typeof v !== 'string' || !v.trim()) {
      this.err(where, 'must be a non-empty string');
      return '';
    }
    if (re && !re.test(v)) this.err(where, `invalid value "${v}"`);
    return v;
  }
  strs(v: unknown, where: string, re?: RegExp): string[] {
    return this.arr(v, where).map((x, i) => this.str(x, `${where}[${i}]`, re));
  }
  oneOf<T extends string>(v: unknown, where: string, options: readonly T[]): T {
    if (!options.includes(v as T)) this.err(where, `must be one of ${options.join(', ')}`);
    return v as T;
  }
  int(v: unknown, where: string, min: number, max: number): number {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max)
      this.err(where, `must be an integer ${min}..${max}`);
    return v as number;
  }
  uniqueIds(items: { id: string }[], where: string): void {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.id)) this.err(where, `duplicate id "${it.id}"`);
      seen.add(it.id);
    }
  }
}

export function validateHomeConfig(raw: unknown): HomeConfig {
  const v = new V();
  const top = v.obj(raw, 'config', [
    'version',
    'agents',
    'google_accounts',
    'mailboxes',
    'calendars',
    'reminders',
    'omnifocus',
    'notes',
    'destinations',
    'personal_watch',
    'schedule',
  ]);
  if (top.version !== 1) v.err('version', 'must be 1');

  const agents = v.strs(top.agents, 'agents', ID);
  const agentSet = new Set(agents);
  const agentRef = (a: string, where: string): void => {
    if (a && !agentSet.has(a)) v.err(where, `unknown agent "${a}"`);
  };
  const usedBy = (x: unknown, where: string): UsedBy => {
    const out: UsedBy = [];
    v.strs(x, where).forEach((s, i) => {
      const m = /^([a-z][a-z0-9-]*)(:read)?$/.exec(s);
      if (!m) return v.err(`${where}[${i}]`, `invalid entry "${s}" (use "<agent>" or "<agent>:read")`);
      agentRef(m[1], `${where}[${i}]`);
      if (out.some((u) => u.agent === m[1])) v.err(`${where}[${i}]`, `agent "${m[1]}" listed twice`);
      out.push({ agent: m[1], readOnly: !!m[2] });
    });
    return out;
  };

  const accounts: GoogleAccount[] = v.arr(top.google_accounts, 'google_accounts').map((x, i) => {
    const w = `google_accounts[${i}]`;
    const o = v.obj(x, w, ['id', 'address', 'scopes']);
    const scopes = v.strs(o.scopes, `${w}.scopes`);
    for (const s of scopes) if (s && !SCOPES.has(s)) v.err(`${w}.scopes`, `scope "${s}" not allowed`);
    return { id: v.str(o.id, `${w}.id`, ID), address: v.str(o.address, `${w}.address`, EMAIL), scopes };
  });
  v.uniqueIds(accounts, 'google_accounts');
  const accountIds = new Set(accounts.map((a) => a.id));
  const accountScopes = (id: string): string[] => accounts.find((a) => a.id === id)?.scopes ?? [];

  const mailboxes: Mailbox[] = v.arr(top.mailboxes, 'mailboxes').map((x, i) => {
    const w = `mailboxes[${i}]`;
    const o = v.obj(
      x,
      w,
      ['id', 'account', 'mode', 'forwarders', 'triage', 'used_by'],
      ['id', 'account', 'mode', 'used_by'],
    );
    const mode = v.oneOf(o.mode, `${w}.mode`, ['starred', 'triaged', 'allowlisted-forwarders'] as const);
    const account = v.str(o.account, `${w}.account`);
    if (account && !accountIds.has(account)) v.err(`${w}.account`, `unknown google account "${account}"`);
    else if (account && !accountScopes(account).includes('gmail.readonly'))
      v.err(`${w}.account`, `account "${account}" lacks gmail.readonly`);
    let forwarders: string[] = [];
    if (mode === 'allowlisted-forwarders') {
      forwarders = v.strs(o.forwarders, `${w}.forwarders`, EMAIL).map((f) => f.toLowerCase());
      if (forwarders.length === 0) v.err(`${w}.forwarders`, 'must list at least one forwarder');
    } else if ('forwarders' in o) v.err(`${w}.forwarders`, 'only valid with mode allowlisted-forwarders');
    let triage: TriageConfig | undefined;
    if (mode === 'triaged') {
      const t = v.obj(o.triage, `${w}.triage`, ['query', 'project', 'region', 'model']);
      triage = {
        query: v.str(t.query, `${w}.triage.query`),
        project: v.str(t.project, `${w}.triage.project`, /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
        region: v.str(t.region, `${w}.triage.region`, /^[a-z0-9-]{2,40}$/),
        model: v.str(t.model, `${w}.triage.model`, /^[a-z0-9][a-z0-9.@-]{1,80}$/),
      };
      if (/\bis:starred\b/i.test(triage.query)) v.err(`${w}.triage.query`, 'starred mail is already included');
    } else if ('triage' in o) v.err(`${w}.triage`, 'only valid with mode triaged');
    return {
      id: v.str(o.id, `${w}.id`, ID),
      account,
      mode,
      forwarders,
      ...(triage ? { triage } : {}),
      used_by: usedBy(o.used_by, `${w}.used_by`),
    };
  });
  v.uniqueIds(mailboxes, 'mailboxes');

  const calendars: Calendar[] = v.arr(top.calendars, 'calendars').map((x, i) => {
    const w = `calendars[${i}]`;
    const o = v.obj(x, w, ['id', 'account', 'calendar', 'access', 'used_by']);
    const access = v.oneOf(o.access, `${w}.access`, ['read', 'write'] as const);
    const account = v.str(o.account, `${w}.account`);
    if (account && !accountIds.has(account)) v.err(`${w}.account`, `unknown google account "${account}"`);
    else if (account) {
      const sc = accountScopes(account);
      if (access === 'write' && !sc.includes('calendar.events.owned'))
        v.err(`${w}.access`, `account "${account}" lacks calendar.events.owned`);
      if (!sc.some((s) => s.startsWith('calendar.')))
        v.err(`${w}.account`, `account "${account}" has no calendar scope`);
    }
    return {
      id: v.str(o.id, `${w}.id`, ID),
      account,
      calendar: v.str(o.calendar, `${w}.calendar`),
      access,
      used_by: usedBy(o.used_by, `${w}.used_by`),
    };
  });
  v.uniqueIds(calendars, 'calendars');

  const namedItems = (x: unknown, w: string): NamedItem[] => {
    const items = v.arr(x, w).map((y, i) => {
      const o = v.obj(y, `${w}[${i}]`, ['id', 'name', 'used_by']);
      return {
        id: v.str(o.id, `${w}[${i}].id`, ID),
        name: v.str(o.name, `${w}[${i}].name`),
        used_by: usedBy(o.used_by, `${w}[${i}].used_by`),
      };
    });
    v.uniqueIds(items, w);
    return items;
  };
  const rem = v.obj(top.reminders, 'reminders', ['unrestricted', 'lists']);
  const reminders = {
    unrestricted: v.strs(rem.unrestricted, 'reminders.unrestricted'),
    lists: namedItems(rem.lists, 'reminders.lists'),
  };
  reminders.unrestricted.forEach((a, i) => agentRef(a, `reminders.unrestricted[${i}]`));

  const of = v.obj(top.omnifocus, 'omnifocus', ['used_by']);
  const omnifocus = { used_by: usedBy(of.used_by, 'omnifocus.used_by') };

  const nt = v.obj(top.notes, 'notes', ['unrestricted', 'read_all', 'folders'], ['unrestricted', 'folders']);
  const notes = {
    unrestricted: v.strs(nt.unrestricted, 'notes.unrestricted'),
    read_all: nt.read_all === undefined ? [] : v.strs(nt.read_all, 'notes.read_all'),
    folders: namedItems(nt.folders, 'notes.folders'),
  };
  notes.unrestricted.forEach((a, i) => agentRef(a, `notes.unrestricted[${i}]`));
  notes.read_all.forEach((a, i) => {
    agentRef(a, `notes.read_all[${i}]`);
    if (notes.unrestricted.includes(a)) v.err(`notes.read_all[${i}]`, `"${a}" is also in notes.unrestricted`);
  });

  const listIds = new Set(reminders.lists.map((l) => l.id));
  const calIds = new Set(calendars.map((c) => c.id));
  const destinations: Record<string, Destination> = {};
  const dst = v.obj(top.destinations, 'destinations', Object.keys((top.destinations as Obj) ?? {}), []);
  for (const [kind, d] of Object.entries(dst)) {
    const w = `destinations.${kind}`;
    if (!ID.test(kind)) v.err(w, 'invalid kind name');
    const o = v.obj(d, w, ['list', 'calendar'], []);
    if (!('list' in o) && !('calendar' in o)) v.err(w, 'needs a list and/or a calendar');
    const out: Destination = {};
    if ('list' in o) {
      out.list = v.str(o.list, `${w}.list`);
      if (out.list && !listIds.has(out.list) && !SPECIAL_LISTS.has(out.list))
        v.err(`${w}.list`, `unknown list "${out.list}"`);
    }
    if ('calendar' in o) {
      out.calendar = v.str(o.calendar, `${w}.calendar`);
      const cal = calendars.find((c) => c.id === out.calendar);
      if (out.calendar && !calIds.has(out.calendar)) v.err(`${w}.calendar`, `unknown calendar "${out.calendar}"`);
      else if (cal && cal.access !== 'write') v.err(`${w}.calendar`, `calendar "${out.calendar}" is read-only`);
    }
    destinations[kind] = out;
  }

  const personal_watch = v
    .arr(top.personal_watch, 'personal_watch')
    .map((x, i) => v.oneOf(x, `personal_watch[${i}]`, ['omnifocus', 'reminders'] as const));

  const sc = v.obj(top.schedule, 'schedule', ['quiet_hours', 'brief_time', 'stale_days', 'nudge_cap']);
  const qh = v.str(sc.quiet_hours, 'schedule.quiet_hours');
  const qm = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(qh);
  if (qh && (!qm || !HHMM.test(qm[1]) || !HHMM.test(qm[2]))) v.err('schedule.quiet_hours', 'must be "HH:MM-HH:MM"');
  const schedule = {
    quiet_hours: { start: qm?.[1] ?? '', end: qm?.[2] ?? '' },
    brief_time: v.str(sc.brief_time, 'schedule.brief_time', HHMM),
    stale_days: v.int(sc.stale_days, 'schedule.stale_days', 1, 365),
    nudge_cap: v.int(sc.nudge_cap, 'schedule.nudge_cap', 1, 20),
  };

  if (v.problems.length) throw new HomeConfigError(v.problems);
  return {
    version: 1,
    agents,
    google_accounts: accounts,
    mailboxes,
    calendars,
    reminders,
    omnifocus,
    notes,
    destinations,
    personal_watch,
    schedule,
  };
}

export function parseHomeConfig(text: string): HomeConfig {
  let raw: unknown;
  try {
    raw = parse(text, { uniqueKeys: true });
  } catch (e) {
    throw new HomeConfigError([`yaml: ${(e as Error).message}`]);
  }
  return validateHomeConfig(raw);
}

/** Load from disk. Refuses a file readable by group/other (it names private addresses). */
export function loadHomeConfig(file = process.env.HOME_CONFIG ?? DEFAULT_HOME_CONFIG_PATH): HomeConfig {
  const st = fs.statSync(file);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0)
    throw new HomeConfigError([`${file}: mode ${(st.mode & 0o777).toString(8)} is too open, chmod 600`]);
  return parseHomeConfig(fs.readFileSync(file, 'utf8'));
}

/** Effective access of `agent` to a resource with `used_by`, capped by the resource's own access. */
export function accessFor(used_by: UsedBy, agent: string, resourceAccess: 'read' | 'write' = 'write'): Access {
  const u = used_by.find((x) => x.agent === agent);
  if (!u) return 'none';
  return u.readOnly || resourceAccess === 'read' ? 'read' : 'write';
}

export function mailboxFor(cfg: HomeConfig, id: string, agent: string): Mailbox | null {
  const m = cfg.mailboxes.find((x) => x.id === id);
  return m && accessFor(m.used_by, agent, 'read') !== 'none' ? m : null;
}

export function calendarFor(cfg: HomeConfig, id: string, agent: string, need: 'read' | 'write'): Calendar | null {
  const c = cfg.calendars.find((x) => x.id === id);
  if (!c) return null;
  const a = accessFor(c.used_by, agent, c.access);
  return a === 'write' || (a === 'read' && need === 'read') ? c : null;
}

/** Reminders list names an agent may see; null = unrestricted. */
export function reminderListsFor(cfg: HomeConfig, agent: string): string[] | null {
  if (cfg.reminders.unrestricted.includes(agent)) return null;
  return cfg.reminders.lists.filter((l) => accessFor(l.used_by, agent) !== 'none').map((l) => l.name);
}

/** Notes folder names an agent may use; null = unrestricted. For read_all agents: the folders it may write. */
export function noteFoldersFor(cfg: HomeConfig, agent: string): string[] | null {
  if (cfg.notes.unrestricted.includes(agent)) return null;
  const need = cfg.notes.read_all.includes(agent) ? 'write' : 'read';
  return cfg.notes.folders
    .filter((f) => {
      const a = accessFor(f.used_by, agent);
      return need === 'write' ? a === 'write' : a !== 'none';
    })
    .map((f) => f.name);
}

// CLI: `pnpm exec tsx scripts/home-config.ts [file]` validates and prints a per-agent summary (no addresses).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const cfg = loadHomeConfig(process.argv[2]);
    for (const a of cfg.agents) {
      const mb = cfg.mailboxes.filter((m) => mailboxFor(cfg, m.id, a)).map((m) => m.id);
      const cal = cfg.calendars
        .map((c) => `${c.id}:${accessFor(c.used_by, a, c.access)}`)
        .filter((s) => !s.endsWith(':none'));
      const rl = reminderListsFor(cfg, a);
      const nf = noteFoldersFor(cfg, a);
      console.log(
        `${a}: mailboxes=[${mb}] calendars=[${cal}] reminders=${rl ? `[${rl}]` : 'all'} notes=${nf ? (cfg.notes.read_all.includes(a) ? `read all, write [${nf}]` : `[${nf}]`) : 'all'} omnifocus=${accessFor(cfg.omnifocus.used_by, a)}`,
      );
    }
    console.log('OK');
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
