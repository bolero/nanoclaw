import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  accessFor,
  calendarFor,
  HomeConfigError,
  loadHomeConfig,
  mailboxFor,
  noteFoldersFor,
  parseHomeConfig,
  reminderListsFor,
  validateHomeConfig,
} from './home-config.js';

const EXAMPLE = fs.readFileSync(path.join(__dirname, '..', 'homelab', 'home.example.yaml'), 'utf8');
const base = () => parse(EXAMPLE) as Record<string, any>;
const problems = (raw: unknown): string[] => {
  try {
    validateHomeConfig(raw);
    return [];
  } catch (e) {
    if (e instanceof HomeConfigError) return e.problems;
    throw e;
  }
};

describe('home config', () => {
  it('accepts the example', () => {
    const cfg = parseHomeConfig(EXAMPLE);
    expect(cfg.agents).toEqual(['bono', 'family', 'argus']);
    expect(cfg.schedule.quiet_hours).toEqual({ start: '21:00', end: '07:00' });
  });

  it('rejects unknown keys at any level', () => {
    const c = base();
    c.extra = 1;
    c.mailboxes[0].colour = 'red';
    expect(problems(c)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unknown key "extra"'),
        expect.stringContaining('unknown key "colour"'),
      ]),
    );
  });

  it('rejects missing destinations and unknown references', () => {
    const c = base();
    c.destinations.school.list = 'nope';
    c.destinations.household.calendar = 'nope';
    c.calendars[0].account = 'ghost';
    c.mailboxes[1].used_by = ['stranger'];
    const p = problems(c);
    expect(p).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unknown list "nope"'),
        expect.stringContaining('unknown calendar "nope"'),
        expect.stringContaining('unknown google account "ghost"'),
        expect.stringContaining('unknown agent "stranger"'),
      ]),
    );
  });

  it('rejects a destination on a read-only calendar and a write calendar without the scope', () => {
    const c = base();
    c.destinations.school.calendar = 'personal';
    c.calendars[0].access = 'write';
    const p = problems(c);
    expect(p.some((s) => s.includes('lacks calendar.events.owned'))).toBe(true);
    const c2 = base();
    c2.destinations.school.calendar = 'personal';
    expect(problems(c2).some((s) => s.includes('is read-only'))).toBe(true);
  });

  it('requires forwarders only for allowlisted-forwarders', () => {
    const c = base();
    c.mailboxes[1].forwarders = [];
    c.mailboxes[0].forwarders = ['a@b.com'];
    const p = problems(c);
    expect(p.some((s) => s.includes('at least one forwarder'))).toBe(true);
    expect(p.some((s) => s.includes('only valid with mode'))).toBe(true);
  });

  it('rejects unlisted scopes, bad times and duplicate ids', () => {
    const c = base();
    c.google_accounts[0].scopes.push('gmail.modify');
    c.schedule.brief_time = '25:00';
    c.schedule.quiet_hours = '9pm-7am';
    c.calendars[1].id = 'personal';
    const p = problems(c);
    expect(p.some((s) => s.includes('"gmail.modify" not allowed'))).toBe(true);
    expect(p.some((s) => s.includes('brief_time'))).toBe(true);
    expect(p.some((s) => s.includes('quiet_hours'))).toBe(true);
    expect(p.some((s) => s.includes('duplicate id "personal"'))).toBe(true);
  });

  it('rejects duplicate yaml keys', () => {
    expect(() => parseHomeConfig('version: 1\nversion: 1\n')).toThrow(HomeConfigError);
  });

  it('enforces the privacy wall through used_by', () => {
    const cfg = parseHomeConfig(EXAMPLE);
    expect(mailboxFor(cfg, 'personal', 'family')).toBeNull();
    expect(mailboxFor(cfg, 'family-inbox', 'bono')).toBeNull();
    expect(mailboxFor(cfg, 'personal', 'bono')?.mode).toBe('starred');
    expect(calendarFor(cfg, 'personal', 'family', 'read')).toBeNull();
    expect(calendarFor(cfg, 'school', 'bono', 'read')?.id).toBe('school');
    expect(calendarFor(cfg, 'school', 'bono', 'write')).toBeNull();
    expect(calendarFor(cfg, 'school', 'family', 'write')?.id).toBe('school');
    expect(calendarFor(cfg, 'personal', 'bono', 'write')).toBeNull();
    expect(calendarFor(cfg, 'missing', 'bono', 'read')).toBeNull();
    expect(reminderListsFor(cfg, 'family')).toEqual(['Kids', 'Family']);
    expect(reminderListsFor(cfg, 'bono')).toBeNull();
    expect(reminderListsFor(cfg, 'argus')).toEqual([]);
    expect(noteFoldersFor(cfg, 'family')).toEqual(['Family']);
    // read_all agents: the result is the folders they may WRITE; ":read" entries are excluded
    expect(noteFoldersFor(cfg, 'bono')).toEqual(['Family']);
    const ro = parseHomeConfig(
      fs.readFileSync(path.join(__dirname, '..', 'homelab', 'home.example.yaml'), 'utf8').replace(
        'used_by: [family, bono]}',
        'used_by: [family, "bono:read"]}',
      ),
    );
    expect(noteFoldersFor(ro, 'bono')).toEqual([]);
    expect(accessFor(cfg.omnifocus.used_by, 'family')).toBe('none');
  });

  it('refuses a world-readable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecfg-'));
    const f = path.join(dir, 'home.yaml');
    fs.writeFileSync(f, stringify(base()), { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    expect(() => loadHomeConfig(f)).toThrow(/too open/);
    fs.chmodSync(f, 0o600);
    expect(loadHomeConfig(f).agents).toContain('bono');
  });
});
