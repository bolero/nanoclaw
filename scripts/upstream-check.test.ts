import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { check, classify, summarize } from './upstream-check.js';

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
}

describe('upstream-check', () => {
  it('classifies security, breaking and release commits', () => {
    const c = classify([
      'fix(container): clear known fixable advisories from the agent image (#1)',
      'feat(api)!: drop the v1 routes',
      'chore(release): v2026.11.0-beta.2 (#2)',
      'fix(router): stop holding follow-ups',
    ]);
    expect(c.security).toHaveLength(1);
    expect(c.breaking).toHaveLength(1);
    expect(c.release).toBe('v2026.11.0-beta.2');
  });

  it('summarizes, treating lockfile-only conflicts as clean', () => {
    const base = { behind: 3, ahead: 1, upstreamHead: 'x', security: [], breaking: [], latestRelease: null };
    expect(summarize({ ...base, conflicts: ['pnpm-lock.yaml', 'container/agent-runner/bun.lock'] })).toMatch(
      /merges cleanly apart from lockfiles/,
    );
    expect(summarize({ ...base, conflicts: ['src/router.ts'] })).toMatch(/merge conflicts in src\/router.ts/);
    expect(summarize({ ...base, conflicts: [] })).toMatch(/^NanoClaw: 3 upstream updates; merges cleanly/);
  });

  it('counts commits and finds conflicts without touching the checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
    const up = path.join(root, 'up');
    const fork = path.join(root, 'fork');
    fs.mkdirSync(up);
    sh(up, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(up, 'a.txt'), 'one\n');
    sh(up, 'add', '.');
    sh(up, 'commit', '-qm', 'init');
    sh(root, 'clone', '-q', up, fork);
    sh(fork, 'remote', 'rename', 'origin', 'upstream');
    fs.writeFileSync(path.join(fork, 'a.txt'), 'fork\n');
    sh(fork, 'commit', '-qam', 'fork change');
    fs.writeFileSync(path.join(up, 'a.txt'), 'upstream\n');
    sh(up, 'commit', '-qam', 'fix: security hardening');
    const r = check(fork, 'upstream', 'main');
    expect(r.behind).toBe(1);
    expect(r.ahead).toBe(1);
    expect(r.conflicts).toEqual(['a.txt']);
    expect(r.security).toHaveLength(1);
    expect(fs.readFileSync(path.join(fork, 'a.txt'), 'utf8')).toBe('fork\n');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
