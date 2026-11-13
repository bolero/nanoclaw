/**
 * Gatus → NanoClaw webhook sidecar.
 *
 * Tiny HTTP server that turns alert POSTs into agent messages by writing
 * one JSON line to the CLI admin socket (data/cli.sock) with `to` set to the
 * target chat. Replies are delivered by the normal router/delivery path, so
 * the agent answers in that chat (e.g. Telegram).
 *
 * Env:
 *   WEBHOOK_SECRET       required — shared secret, sent as `X-Webhook-Secret`
 *   WEBHOOK_HOST         bind address (default 127.0.0.1; use the Tailscale IP)
 *   WEBHOOK_PORT         default 8787
 *   PROXY_PROBE_HOST     where /health probes the Dockhand proxy (default 127.0.0.1)
 *   TARGET_CHANNEL_TYPE  default "telegram"
 *   TARGET_PLATFORM_ID   required — e.g. "telegram:8858403005"
 *   TARGET_THREAD_ID     optional — topic/thread id
 *   REPEAT_SUPPRESS_MIN  drop repeat "triggered" alerts per endpoint (default 30)
 *   RESOLVE_DELAY_SEC    hold "resolved" this long; cancelled if it re-triggers (default 90)
 *
 * Auth header: `X-Webhook-Secret` or `X-Gitlab-Token` (Hermes-compatible).
 * Body (JSON): { "endpoint": "plex", "status"|"state": "triggered"|"resolved" (case-insensitive),
 *                "description": "...", "url": "..." }
 *
 * Run: WEBHOOK_SECRET=... TARGET_PLATFORM_ID=... pnpm exec tsx scripts/gatus-webhook.ts
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import http from 'http';
import net from 'net';
import path from 'path';

import { formatAlert as format } from './alert-data.js';

const SECRET = process.env.WEBHOOK_SECRET ?? '';
const HOST = process.env.WEBHOOK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.WEBHOOK_PORT ?? 8787);
const CHANNEL_TYPE = process.env.TARGET_CHANNEL_TYPE ?? 'telegram';
const PLATFORM_ID = process.env.TARGET_PLATFORM_ID ?? '';
const THREAD_ID = process.env.TARGET_THREAD_ID ?? null;
const REPEAT_MS = Number(process.env.REPEAT_SUPPRESS_MIN ?? 30) * 60_000;
const RESOLVE_MS = Number(process.env.RESOLVE_DELAY_SEC ?? 90) * 1000;
const SOCK = process.env.CLI_SOCKET ?? path.join(process.cwd(), 'data', 'cli.sock');

if (!SECRET || !PLATFORM_ID) {
  console.error('WEBHOOK_SECRET and TARGET_PLATFORM_ID are required');
  process.exit(1);
}

// Append-only alert log, readable by agents (mounted read-only). journal_mode=DELETE keeps it
// readable across a read-only bind mount.
const ALERT_DB = process.env.ALERT_DB_PATH ?? path.join(os.homedir(), 'nanoclaw-alerts', 'alerts.db');
fs.mkdirSync(path.dirname(ALERT_DB), { recursive: true });
const alertDb = new Database(ALERT_DB);
alertDb.pragma('journal_mode = DELETE');
alertDb.exec(`CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  grp TEXT,
  status TEXT NOT NULL,
  description TEXT,
  url TEXT,
  outcome TEXT NOT NULL
)`);
const insertAlert = alertDb.prepare(
  'INSERT INTO alerts (ts, endpoint, grp, status, description, url, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

const lastTriggered = new Map<string, number>();
const inFlight = new Set<string>();
const pendingResolve = new Map<string, NodeJS.Timeout>();

function sendToAgent(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    s.once('error', reject);
    s.once('connect', () => {
      const msg = {
        text,
        sender: 'gatus',
        senderId: 'webhook:gatus',
        to: { channelType: CHANNEL_TYPE, platformId: PLATFORM_ID, threadId: THREAD_ID },
      };
      s.end(JSON.stringify(msg) + '\n', () => resolve());
    });
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function handleInner(body: Record<string, unknown>): Promise<string> {
  const endpoint = String(body.endpoint ?? 'unknown').slice(0, 100);
  // Accept `status` (ours) or `state` (Hermes-style body); Gatus sends TRIGGERED/RESOLVED by default.
  const status = String(body.status ?? body.state ?? '').toLowerCase() === 'resolved' ? 'resolved' : 'triggered';
  const description = String(body.description ?? '').slice(0, 300);
  const url = String(body.url ?? '').slice(0, 300);

  if (status === 'triggered') {
    const pending = pendingResolve.get(endpoint);
    if (pending) {
      clearTimeout(pending); // flapped back down within the window: drop the pending recovery
      pendingResolve.delete(endpoint);
      return 'flap-suppressed';
    }
    const last = lastTriggered.get(endpoint) ?? 0;
    if (Date.now() - last < REPEAT_MS) return 'repeat-suppressed';
    if (lastTriggered.size > 500) return 'dropped-too-many-endpoints';
    if (inFlight.has(endpoint)) return 'repeat-suppressed';
    inFlight.add(endpoint);
    try {
      await sendToAgent(format('triggered', endpoint, description, url));
    } finally {
      inFlight.delete(endpoint);
    }
    lastTriggered.set(endpoint, Date.now()); // only after a successful send, so a failed send is retried
    return 'sent';
  }

  if (!lastTriggered.has(endpoint)) return 'resolve-without-trigger';
  if (pendingResolve.has(endpoint)) return 'resolve-already-pending';
  pendingResolve.set(
    endpoint,
    setTimeout(() => {
      pendingResolve.delete(endpoint);
      lastTriggered.delete(endpoint);
      sendToAgent(format('resolved', endpoint, description, url)).catch((e) => console.error('resolve send failed', e));
    }, RESOLVE_MS),
  );
  return 'resolve-queued';
}

async function handle(body: Record<string, unknown>): Promise<string> {
  let outcome: string;
  try {
    outcome = await handleInner(body);
  } catch (e) {
    outcome = 'send-failed';
    console.error('alert send failed', e);
  }
  try {
    const st = String(body.status ?? body.state ?? '').toLowerCase() === 'resolved' ? 'resolved' : 'triggered';
    insertAlert.run(
      new Date().toISOString(),
      String(body.endpoint ?? 'unknown').slice(0, 100),
      body.group ? String(body.group).slice(0, 100) : null,
      st,
      String(body.description ?? '').slice(0, 300),
      String(body.url ?? '').slice(0, 300),
      outcome,
    );
  } catch (e) {
    console.error('alert log failed', e);
  }
  if (outcome === 'send-failed') throw new Error('send-failed');
  return outcome;
}

http
  .createServer((req, res) => {
    const reply = (code: number, msg: string) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(msg + '\n');
    };
    if (req.method === 'GET' && req.url === '/health') {
      // Unauthenticated liveness for Gatus: the NanoClaw host socket and the read-only Dockhand proxy.
      const probe = (open: () => net.Socket) =>
        new Promise<boolean>((resolve) => {
          const sock = open();
          const done = (ok: boolean) => {
            sock.destroy();
            resolve(ok);
          };
          sock.setTimeout(2000, () => done(false));
          sock.once('error', () => done(false));
          sock.once('connect', () => done(true));
        });
      Promise.all([
        probe(() => net.createConnection(SOCK)),
        probe(() =>
          net.createConnection({
            // Linux hosts bind the proxy to the docker bridge, not loopback.
            host: process.env.PROXY_PROBE_HOST ?? '127.0.0.1',
            port: Number(process.env.PROXY_PORT ?? 8790),
          }),
        ),
      ]).then(([host, proxy]) => {
        const ok = host && proxy;
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ status: ok ? 'ok' : 'degraded', host: host ? 'ok' : 'down', proxy: proxy ? 'ok' : 'down' }) +
            '\n',
        );
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/alert') return reply(404, 'not found');
    // `X-Gitlab-Token` is accepted too so a Gatus config written for Hermes works unchanged.
    const presented = String(req.headers['x-webhook-secret'] ?? req.headers['x-gitlab-token'] ?? '');
    if (!safeEqual(presented, SECRET)) return reply(401, 'unauthorized');
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 16_384) req.destroy();
    });
    req.on('end', async () => {
      try {
        reply(200, await handle(JSON.parse(raw || '{}')));
      } catch (e) {
        console.error('alert failed', e);
        reply(500, 'error');
      }
    });
  })
  .listen(PORT, HOST, () => console.log(`gatus-webhook listening on ${HOST}:${PORT} → ${PLATFORM_ID}`));
