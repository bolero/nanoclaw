/* eslint-disable no-catch-all/no-catch-all -- push failures are reported as results, never thrown into delivery */
/**
 * Apple Push Notification service for the app channel.
 *
 * Token-based auth: an ES256 JWT signed with the team's .p8 key, sent over
 * HTTP/2 to api.push.apple.com (production) or api.sandbox.push.apple.com
 * (development builds). The key stays host-side; agents never see it. No
 * dependencies — node:http2 and node:crypto only.
 *
 * Policy (decidePush): push only when the person is likely not looking —
 *  - "needs you" cards always;
 *  - other agent messages only when the agent spoke first (the person has
 *    not written in that conversation for PROACTIVE_GAP_MS), e.g. briefs,
 *    alerts, nudges — replies to something you just asked stay quiet;
 *  - nothing while one of the person's devices holds a live event stream
 *    (the app is open and shows it anyway);
 *  - in quiet hours notifications are delivered silently (passive, no
 *    sound), except for agents listed as urgent, which break through.
 */
import crypto from 'crypto';
import fs from 'fs';
import http2 from 'http2';

import { log } from '../../log.js';

export const PROACTIVE_GAP_MS = 10 * 60 * 1000;

export interface PushConfig {
  keyFile: string;
  keyId: string;
  teamId: string;
  topic: string;
  /** Local hours [start, end) when pushes go silent, e.g. [21, 7]. */
  quietHours: [number, number] | null;
  /** Agent folders whose pushes break through quiet hours. */
  urgentAgents: string[];
  timezone: string;
  /** Live install-wide setting (src/quiet-hours.ts); overrides the static quietHours window. */
  isQuiet?: (now: Date) => boolean;
}

export interface PushDecision {
  send: boolean;
  /** passive = silent delivery (quiet hours); time-sensitive = urgent agent in quiet hours */
  level: 'active' | 'passive' | 'time-sensitive';
  reason: string;
}

export function localHour(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(now);
  return Number(h);
}

export function inQuietHours(hour: number, quiet: [number, number] | null): boolean {
  if (!quiet) return false;
  const [start, end] = quiet;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function decidePush(input: {
  isCard: boolean;
  lastInboundAt: string | null;
  createdAt: string;
  live: boolean;
  agentFolder: string | null;
  config: Pick<PushConfig, 'quietHours' | 'urgentAgents' | 'timezone' | 'isQuiet'>;
  now?: Date;
}): PushDecision {
  const now = input.now ?? new Date();
  if (input.live) return { send: false, level: 'active', reason: 'app open' };
  if (!input.isCard && input.lastInboundAt) {
    const gap = Date.parse(input.createdAt) - Date.parse(input.lastInboundAt);
    if (gap < PROACTIVE_GAP_MS) return { send: false, level: 'active', reason: 'reply to a recent message' };
  }
  const quiet = input.config.isQuiet
    ? input.config.isQuiet(now)
    : inQuietHours(localHour(now, input.config.timezone), input.config.quietHours);
  if (!quiet) return { send: true, level: 'active', reason: input.isCard ? 'needs you' : 'agent spoke first' };
  if (input.agentFolder && input.config.urgentAgents.includes(input.agentFolder)) {
    return { send: true, level: 'time-sensitive', reason: 'urgent agent in quiet hours' };
  }
  return { send: true, level: 'passive', reason: 'quiet hours' };
}

/** Lock-screen text: agent name plus the first meaningful line, Markdown stripped. */
export function previewLine(text: string, max = 140): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~|]/g, '')
      .trim();
    if (line && !/^-{3,}$/.test(line)) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export class ApnsClient {
  private jwt: { token: string; at: number } | null = null;
  private sessions = new Map<string, http2.ClientHttp2Session>();
  private readonly key: crypto.KeyObject;

  constructor(private readonly config: Pick<PushConfig, 'keyFile' | 'keyId' | 'teamId' | 'topic'>) {
    this.key = crypto.createPrivateKey(fs.readFileSync(config.keyFile));
  }

  /** Apple wants a JWT no older than an hour and refreshed at most every 20 minutes. */
  private bearer(): string {
    const nowS = Math.floor(Date.now() / 1000);
    if (this.jwt && nowS - this.jwt.at < 40 * 60) return this.jwt.token;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'ES256', kid: this.config.keyId })}.${enc({ iss: this.config.teamId, iat: nowS })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: this.key, dsaEncoding: 'ieee-p1363' });
    this.jwt = { token: `${unsigned}.${sig.toString('base64url')}`, at: nowS };
    return this.jwt.token;
  }

  private session(env: 'development' | 'production'): http2.ClientHttp2Session {
    const origin = env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin);
    s.on('error', (err) => log.warn('APNs connection error', { err: err.message }));
    s.on('close', () => this.sessions.delete(origin));
    s.unref();
    this.sessions.set(origin, s);
    return s;
  }

  send(
    deviceToken: string,
    env: 'development' | 'production',
    payload: Record<string, unknown>,
    opts: { collapseId?: string; priority?: 5 | 10 } = {},
  ): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(env).request({
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${this.bearer()}`,
          'apns-topic': this.config.topic,
          'apns-push-type': 'alert',
          'apns-priority': String(opts.priority ?? 10),
          ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId.slice(0, 64) } : {}),
        });
      } catch (err) {
        resolve({ ok: false, status: 0, reason: (err as Error).message });
        return;
      }
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          reason = body.slice(0, 200);
        }
        resolve({ ok: status === 200, status, reason });
      });
      req.on('error', (err) => resolve({ ok: false, status, reason: err.message }));
      req.setTimeout(15_000, () => {
        req.close();
        resolve({ ok: false, status, reason: 'timeout' });
      });
      req.end(JSON.stringify(payload));
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

/** True when APNs says this token will never work again. */
export function isDeadToken(result: ApnsResult): boolean {
  return result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'Unregistered';
}

export function parseQuietHours(raw: string | undefined): [number, number] | null {
  const v = (raw ?? '21-7').trim();
  if (v === '' || v === 'off') return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
  if (!m) throw new Error(`Invalid APP_PUSH_QUIET_HOURS ${JSON.stringify(raw)}: expected "21-7" or "off"`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23) throw new Error(`Invalid APP_PUSH_QUIET_HOURS ${JSON.stringify(raw)}`);
  return [start, end];
}
