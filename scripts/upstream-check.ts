/**
 * Weekly upstream check (no model, changes nothing in the live checkout).
 *
 * Fetches the upstream remote, lists new commits, flags security and breaking ones,
 * trial-merges them into the current HEAD in a throwaway worktree, and posts one line to an
 * app user's Home chat (`ncl app notify`) when there is something new since the last notice.
 *
 *   pnpm exec tsx scripts/upstream-check.ts [--notify <handle>] [--remote upstream] [--branch main] [--dry-run]
 *
 * Env: UPSTREAM_CHECK_NOTIFY (handle), UPSTREAM_REMOTE_URL (added as the remote when missing).
 * State: ~/.local/state/nanoclaw/upstream-check.json (last upstream commit notified).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CheckResult {
  behind: number;
  ahead: number;
  upstreamHead: string;
  security: string[];
  breaking: string[];
  conflicts: string[];
  latestRelease: string | null;
}

const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|bun\.lock|package-lock\.json|package\.json)$/;

export function classify(subjects: string[]): { security: string[]; breaking: string[]; release: string | null } {
  const security = subjects.filter((s) => /\b(security|cve-\d|vulnerab|advisor(y|ies)|exploit|injection)\b/i.test(s));
  const breaking = subjects.filter((s) => /^\w+(\([^)]*\))?!:|\bbreaking\b/i.test(s));
  const rel = subjects.map((s) => /\brelease\)?:?\s*(v\d[\w.-]*)/i.exec(s)?.[1]).find(Boolean) ?? null;
  return { security, breaking, release: rel };
}

export function summarize(r: CheckResult): string {
  const parts = [`NanoClaw: ${r.behind} upstream update${r.behind === 1 ? '' : 's'}`];
  if (r.latestRelease) parts[0] += ` (up to ${r.latestRelease})`;
  if (r.security.length) parts.push(`${r.security.length} security-related`);
  if (r.breaking.length) parts.push(`${r.breaking.length} marked breaking`);
  const real = r.conflicts.filter((f) => !LOCKFILES.test(f));
  if (real.length) parts.push(`merge conflicts in ${real.slice(0, 4).join(', ')}${real.length > 4 ? '…' : ''}`);
  else if (r.conflicts.length) parts.push('merges cleanly apart from lockfiles');
  else parts.push('merges cleanly');
  return `${parts.join('; ')}. Ask Claude Code to "update NanoClaw" when convenient.`;
}

function git(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

export function check(repo: string, remote: string, branch: string): CheckResult {
  const remotes = git(repo, ['remote']).split('\n');
  if (!remotes.includes(remote)) {
    const url = process.env.UPSTREAM_REMOTE_URL;
    if (!url) throw new Error(`no "${remote}" remote; set UPSTREAM_REMOTE_URL`);
    git(repo, ['remote', 'add', remote, url]);
    git(repo, ['remote', 'set-url', '--push', remote, 'DISABLED']);
  }
  git(repo, ['fetch', '--quiet', remote, branch]);
  const ref = `${remote}/${branch}`;
  const behind = Number(git(repo, ['rev-list', '--count', `HEAD..${ref}`]));
  const ahead = Number(git(repo, ['rev-list', '--count', `${ref}..HEAD`]));
  const upstreamHead = git(repo, ['rev-parse', ref]);
  const subjects = behind
    ? git(repo, ['log', '--format=%s', `HEAD..${ref}`])
        .split('\n')
        .filter(Boolean)
    : [];
  const { security, breaking, release } = classify(subjects);

  let conflicts: string[] = [];
  if (behind) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-check-'));
    const wt = path.join(tmp, 'wt');
    try {
      git(repo, ['worktree', 'add', '--quiet', '--detach', wt, 'HEAD']);
      const merged = git(
        wt,
        ['-c', 'user.name=check', '-c', 'user.email=check@localhost', 'merge', '--no-commit', '--no-ff', ref],
        true,
      );
      void merged;
      conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U'], true).split('\n').filter(Boolean);
      git(wt, ['merge', '--abort'], true);
    } finally {
      git(repo, ['worktree', 'remove', '--force', wt], true);
      fs.rmSync(tmp, { recursive: true, force: true });
      git(repo, ['worktree', 'prune'], true);
    }
  }
  return { behind, ahead, upstreamHead, security, breaking, conflicts, latestRelease: release };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const repo = process.cwd();
  const remote = arg('--remote') ?? 'upstream';
  const branch = arg('--branch') ?? 'main';
  const handle = arg('--notify') ?? process.env.UPSTREAM_CHECK_NOTIFY;
  const dryRun = process.argv.includes('--dry-run');
  const stateFile = path.join(os.homedir(), '.local', 'state', 'nanoclaw', 'upstream-check.json');
  let state: { notified?: string } = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* first run */
  }

  let text: string | null = null;
  let r: CheckResult | null = null;
  try {
    r = check(repo, remote, branch);
    if (r.behind > 0 && r.upstreamHead !== state.notified) text = summarize(r);
  } catch (e) {
    text = `NanoClaw update check failed: ${(e as Error).message.split('\n')[0]}`;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), ...r, text }));
  if (!text || dryRun) return;
  if (handle) {
    execFileSync(
      path.join(repo, 'bin', 'ncl'),
      ['app', 'notify', '--user', handle, '--text', text, '--sender', 'NanoClaw updates'],
      {
        stdio: 'ignore',
        timeout: 30_000,
      },
    );
  }
  if (r) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify({ notified: r.upstreamHead }), { mode: 0o600 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
