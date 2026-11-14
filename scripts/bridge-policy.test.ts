import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { buildPolicy, sha256 } from './bridge-policy.js';
import { parseHomeConfig } from './home-config.js';

const cfg = parseHomeConfig(fs.readFileSync(path.join(__dirname, '..', 'homelab', 'home.example.yaml'), 'utf8'));

describe('bridge policy', () => {
  it('derives per-agent access from home.yaml', () => {
    const p = buildPolicy(cfg, { bono: sha256('k1'), family: sha256('k2') }, new Date('2026-11-10T00:00:00Z'));
    expect(p.callers).toEqual({ [sha256('k1')]: 'bono', [sha256('k2')]: 'family' });
    expect(p.reminders).toEqual({ bono: null, family: ['Kids', 'Family'] });
    expect(p.notes).toEqual({ bono: ['Family'], family: ['Family'] });
    expect(p.notes_read_all).toEqual(['bono']);
    expect(p.omnifocus).toEqual(['bono']);
    expect(p.reminders.argus).toBeUndefined();
  });

  it('rejects unknown agents, bad hashes and shared keys', () => {
    expect(() => buildPolicy(cfg, { stranger: sha256('x') })).toThrow(/not an agent/);
    expect(() => buildPolicy(cfg, { bono: 'abc' })).toThrow(/malformed/);
    expect(() => buildPolicy(cfg, { bono: sha256('x'), family: sha256('x') })).toThrow(/share a key/);
  });

  it('gives the dashboard read-only access to exactly what Today shows', () => {
    const p = buildPolicy(cfg, { bono: sha256('k1'), dashboard: sha256('k3') });
    expect(p.callers[sha256('k3')]).toBe('dashboard');
    expect(p.reminders.dashboard).toEqual(['Family']);
    expect(p.omnifocus).toEqual(['bono', 'dashboard']);
    expect(p.readonly).toEqual(['dashboard']);
    expect(buildPolicy(cfg, { bono: sha256('k1') }).readonly).toBeUndefined();
    const noTasks = { ...cfg, dashboard: { ...cfg.dashboard!, tasks: undefined } };
    expect(() => buildPolicy(noTasks, { dashboard: sha256('k3') })).toThrow(/not an agent/);
  });
});
