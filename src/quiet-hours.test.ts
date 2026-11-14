import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { decidePush } from './channels/app/push.js';
import { describeQuietHours, isQuietNow, normalizeTime, readQuietHours, writeQuietHours } from './quiet-hours.js';

const at = (iso: string) => new Date(iso);

describe('quiet hours', () => {
  it('handles windows across midnight and same-day windows, in the given timezone', () => {
    const night = { enabled: true, start: '21:30', end: '07:00' };
    expect(isQuietNow(night, 'UTC', at('2026-11-14T21:29:00Z'))).toBe(false);
    expect(isQuietNow(night, 'UTC', at('2026-11-14T21:30:00Z'))).toBe(true);
    expect(isQuietNow(night, 'UTC', at('2026-11-15T06:59:00Z'))).toBe(true);
    expect(isQuietNow(night, 'UTC', at('2026-11-15T07:00:00Z'))).toBe(false);
    expect(isQuietNow({ enabled: true, start: '13:00', end: '14:00' }, 'UTC', at('2026-11-14T13:30:00Z'))).toBe(true);
    // 22:00 in Los Angeles is 06:00 UTC
    expect(isQuietNow(night, 'America/Los_Angeles', at('2026-11-14T06:00:00Z'))).toBe(true);
  });

  it('is never quiet when disabled or when start equals end', () => {
    expect(isQuietNow({ enabled: false, start: '00:00', end: '23:59' }, 'UTC', at('2026-11-14T12:00:00Z'))).toBe(false);
    expect(isQuietNow({ enabled: true, start: '07:00', end: '07:00' }, 'UTC', at('2026-11-14T07:00:00Z'))).toBe(false);
  });

  it('normalizes and validates times', () => {
    expect(normalizeTime('7')).toBe('07:00');
    expect(normalizeTime('9:30')).toBe('09:30');
    expect(() => normalizeTime('25:00')).toThrow(/HH:MM/);
    expect(() => normalizeTime('nine')).toThrow(/HH:MM/);
  });

  it('round-trips through the file and reflects edits immediately', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-'));
    const file = path.join(dir, 'quiet-hours.json');
    writeQuietHours({ enabled: true, start: '22:00', end: '06:30', updatedBy: 'host' }, file);
    expect(readQuietHours(file)).toMatchObject({ enabled: true, start: '22:00', end: '06:30', updatedBy: 'host' });
    writeQuietHours({ enabled: false, start: '22:00', end: '06:30' }, file);
    expect(readQuietHours(file).enabled).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('describes the state for agents', () => {
    const q = { enabled: true, start: '21:00', end: '07:00' };
    expect(describeQuietHours(q, 'UTC', at('2026-11-14T22:00:00Z'))).toBe(
      'Quiet hours are ON: 21:00-07:00 (UTC). ACTIVE NOW.',
    );
    expect(describeQuietHours({ ...q, enabled: false }, 'UTC')).toMatch(/OFF/);
  });

  it('push uses the live setting when given', () => {
    const base = {
      isCard: false,
      lastInboundAt: null,
      createdAt: '2026-11-14T22:00:00Z',
      live: false,
      agentFolder: 'bono',
      now: at('2026-11-14T22:00:00Z'),
    };
    const config = { quietHours: [21, 7] as [number, number], urgentAgents: [], timezone: 'UTC' };
    expect(decidePush({ ...base, config: { ...config, isQuiet: () => false } }).level).toBe('active');
    expect(decidePush({ ...base, config: { ...config, isQuiet: () => true } }).level).toBe('passive');
  });
});
