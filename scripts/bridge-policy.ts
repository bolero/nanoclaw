/**
 * Caller policy for the host-side Mac bridges (Reminders, Notes, OmniFocus MCP servers).
 *
 * Each agent gets a random caller key that OneCLI injects as `X-Caller-Key` only into that
 * agent's requests to the bridges' host. The bridges never see home.yaml: they read the
 * generated `bridge-policy.json`, which maps sha256(caller key) -> agent plus what each agent
 * may touch (derived from home.yaml `used_by`). No policy file = bridges keep their old open
 * behaviour, so nothing changes until callers are wired.
 *
 *   pnpm exec tsx scripts/bridge-policy.ts build
 *   pnpm exec tsx scripts/bridge-policy.ts add-caller <agent> --onecli-agent <id> --host <bridge host>
 *   pnpm exec tsx scripts/bridge-policy.ts add-caller <agent> --onecli-agent <id> --target google
 *       (Google broker key: host host.docker.internal, path /google/mcp, file google-callers.json)
 *   pnpm exec tsx scripts/bridge-policy.ts show
 *
 * Files (0600): ~/.config/nanoclaw/bridge-callers.json, ~/.config/nanoclaw/bridge-policy.json
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { accessFor, type HomeConfig, loadHomeConfig, noteFoldersFor, reminderListsFor } from './home-config.js';

const DIR = process.env.NANOCLAW_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'nanoclaw');
export const CALLERS_FILE = path.join(DIR, 'bridge-callers.json');
export const POLICY_FILE = path.join(DIR, 'bridge-policy.json');
export const GOOGLE_CALLERS_FILE = path.join(DIR, 'google-callers.json');

/** agent -> sha256 hex of its caller key */
export type Callers = Record<string, string>;

export interface BridgePolicy {
  version: 1;
  generated_at: string;
  /** sha256(caller key) -> agent */
  callers: Record<string, string>;
  /** agent -> allowed Reminders list names, or null for all lists */
  reminders: Record<string, string[] | null>;
  /** agent -> allowed Notes folder names, or null for all folders (for notes_read_all agents: writable folders) */
  notes: Record<string, string[] | null>;
  /** agents that read every Notes folder and write only in their `notes` folders */
  notes_read_all: string[];
  /** agents allowed to use OmniFocus */
  omnifocus: string[];
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export function buildPolicy(cfg: HomeConfig, callers: Callers, now = new Date()): BridgePolicy {
  const byHash: Record<string, string> = {};
  for (const [agent, hash] of Object.entries(callers)) {
    if (!cfg.agents.includes(agent)) throw new Error(`caller "${agent}" is not an agent in home.yaml`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`caller "${agent}" has a malformed key hash`);
    if (byHash[hash]) throw new Error(`callers "${byHash[hash]}" and "${agent}" share a key`);
    byHash[hash] = agent;
  }
  const reminders: BridgePolicy['reminders'] = {};
  const notes: BridgePolicy['notes'] = {};
  for (const a of cfg.agents) {
    const rl = reminderListsFor(cfg, a);
    if (rl === null || rl.length) reminders[a] = rl;
    const nf = noteFoldersFor(cfg, a);
    if (nf === null || nf.length || cfg.notes.read_all.includes(a)) notes[a] = nf;
  }
  return {
    version: 1,
    generated_at: now.toISOString(),
    callers: byHash,
    reminders,
    notes,
    notes_read_all: cfg.agents.filter((a) => cfg.notes.read_all.includes(a)),
    omnifocus: cfg.agents.filter((a) => accessFor(cfg.omnifocus.used_by, a) !== 'none'),
  };
}

function readCallers(file = CALLERS_FILE): Callers {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Callers;
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function build(): BridgePolicy {
  const policy = buildPolicy(loadHomeConfig(), readCallers());
  writePrivate(POLICY_FILE, policy);
  return policy;
}

function onecli(args: string[]): unknown {
  const out = execFileSync('onecli', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function addCaller(agent: string, onecliAgent: string, host: string, target: 'bridges' | 'google'): void {
  const cfg = loadHomeConfig();
  if (!cfg.agents.includes(agent)) throw new Error(`unknown agent "${agent}"`);
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('--host must be a bare hostname');
  const file = target === 'google' ? GOOGLE_CALLERS_FILE : CALLERS_FILE;
  const callers = readCallers(file);
  if (callers[agent]) throw new Error(`"${agent}" already has a ${target} caller key; remove it from ${file} first`);
  const key = crypto.randomBytes(32).toString('base64url');
  // Pass the key to OneCLI through a private temp file, never argv or stdout.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-key-'));
  const tmp = path.join(tmpDir, 'key');
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  try {
    const created = onecli([
      'secrets',
      'create',
      '--name',
      target === 'google' ? `Google broker caller key (${agent})` : `Bridge caller key (${agent})`,
      '--type',
      'generic',
      '--file',
      tmp,
      '--host-pattern',
      host,
      '--path-pattern',
      target === 'google' ? '/google/mcp' : '/mcp',
      '--header-name',
      'X-Caller-Key',
    ]) as { data?: { id?: string }; id?: string };
    const secretId = created.data?.id ?? created.id;
    if (!secretId) throw new Error('onecli did not return a secret id');
    onecli(['agents', 'grants', 'attach-secret', '--id', onecliAgent, '--secret-id', secretId]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  callers[agent] = sha256(key);
  writePrivate(file, callers);
  if (target === 'bridges') build();
  console.log(`${target} caller key for ${agent} created and attached to OneCLI agent ${onecliAgent}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string): string => {
    const i = rest.indexOf(n);
    if (i < 0 || !rest[i + 1]) throw new Error(`missing ${n}`);
    return rest[i + 1];
  };
  try {
    if (cmd === 'build') {
      const p = build();
      console.log(`wrote ${POLICY_FILE}: ${Object.keys(p.callers).length} caller(s)`);
    } else if (cmd === 'add-caller') {
      const target = rest.includes('--target') ? flag('--target') : 'bridges';
      if (target !== 'bridges' && target !== 'google') throw new Error('--target must be bridges or google');
      addCaller(rest[0], flag('--onecli-agent'), target === 'google' ? 'host.docker.internal' : flag('--host'), target);
    } else if (cmd === 'show') {
      const p = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) as BridgePolicy;
      console.log(
        JSON.stringify(
          { ...p, callers: Object.fromEntries(Object.entries(p.callers).map(([h, a]) => [h.slice(0, 8) + '…', a])) },
          null,
          2,
        ),
      );
    } else {
      console.error('usage: bridge-policy.ts build | show | add-caller <agent> --onecli-agent <id> --host <host>');
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
