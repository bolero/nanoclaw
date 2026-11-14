/**
 * One install-wide quiet-hours setting, read live by everything that should go quiet:
 * app push notifications (silent delivery) and agents (`ncl quiet-hours get` before a
 * non-urgent message). Changed with `ncl quiet-hours set` — from the host directly, or by
 * an agent on a person's request (approval-gated for agents).
 *
 * Stored in data/quiet-hours.json. Until it exists, the legacy APP_PUSH_QUIET_HOURS value
 * ("21-7" or "off") is the default, then 21:00-07:00.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';

export interface QuietHours {
  enabled: boolean;
  /** HH:MM, install timezone */
  start: string;
  /** HH:MM, install timezone; before start means the window crosses midnight */
  end: string;
  updatedAt?: string;
  updatedBy?: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function quietHoursFile(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'quiet-hours.json');
}

function legacyDefault(): QuietHours {
  const raw = (process.env.APP_PUSH_QUIET_HOURS || readEnvFile(['APP_PUSH_QUIET_HOURS']).APP_PUSH_QUIET_HOURS || '')
    .trim()
    .toLowerCase();
  if (raw === 'off') return { enabled: false, start: '21:00', end: '07:00' };
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 24) {
    const pad = (h: string) => `${h.padStart(2, '0')}:00`;
    return { enabled: true, start: pad(m[1]), end: pad(m[2]) };
  }
  return { enabled: true, start: '21:00', end: '07:00' };
}

export function normalizeTime(v: string): string {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(v.trim());
  const t = m ? `${m[1].padStart(2, '0')}:${m[2] ?? '00'}` : '';
  if (!HHMM.test(t)) throw new Error(`invalid time "${v}": use HH:MM (24-hour), e.g. 21:30`);
  return t;
}

let cache: { file: string; mtimeMs: number; value: QuietHours } | null = null;

export function readQuietHours(file = quietHoursFile()): QuietHours {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return legacyDefault();
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.value;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as QuietHours;
    const value: QuietHours = {
      enabled: v.enabled !== false,
      start: normalizeTime(String(v.start)),
      end: normalizeTime(String(v.end)),
      ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}),
      ...(v.updatedBy ? { updatedBy: v.updatedBy } : {}),
    };
    cache = { file, mtimeMs: st.mtimeMs, value };
    return value;
  } catch {
    return legacyDefault();
  }
}

export function writeQuietHours(value: QuietHours, file = quietHoursFile()): QuietHours {
  const clean: QuietHours = {
    enabled: value.enabled,
    start: normalizeTime(value.start),
    end: normalizeTime(value.end),
    updatedAt: value.updatedAt ?? new Date().toISOString(),
    ...(value.updatedBy ? { updatedBy: value.updatedBy } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  cache = null;
  return clean;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone: timezone,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export function isQuietNow(q: QuietHours, timezone: string, now = new Date()): boolean {
  if (!q.enabled) return false;
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === e) return false;
  const t = localMinutes(now, timezone);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export function describeQuietHours(q: QuietHours, timezone: string, now = new Date()): string {
  if (!q.enabled) return `Quiet hours are OFF (window when on: ${q.start}-${q.end}, ${timezone}). Not active now.`;
  return `Quiet hours are ON: ${q.start}-${q.end} (${timezone}). ${isQuietNow(q, timezone, now) ? 'ACTIVE NOW' : 'Not active now'}.`;
}
