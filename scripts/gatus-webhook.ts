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
 *   TARGET_CHANNEL_TYPE  default "telegram"
 *   TARGET_PLATFORM_ID   required — e.g. "telegram:8858403005"
 *   TARGET_THREAD_ID     optional — topic/thread id
 *   REPEAT_SUPPRESS_MIN  drop repeat "triggered" alerts per endpoint (default 30)
 *   RESOLVE_DELAY_SEC    hold "resolved" this long; cancelled if it re-triggers (default 90)
 *
 * Body (JSON): { "endpoint": "plex", "status": "triggered"|"resolved",
 *                "description": "...", "url": "..." }
 *
 * Run: WEBHOOK_SECRET=... TARGET_PLATFORM_ID=... pnpm exec tsx scripts/gatus-webhook.ts
 */
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import path from 'path';

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

const lastTriggered = new Map<string, number>();
const pendingResolve = new Map<string, NodeJS.Timeout>();

function sendToAgent(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    s.once('error', reject);
    s.once('connect', () => {
      const msg = { text, to: { channelType: CHANNEL_TYPE, platformId: PLATFORM_ID, threadId: THREAD_ID } };
      s.end(JSON.stringify(msg) + '\n', () => resolve());
    });
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function format(kind: 'triggered' | 'resolved', endpoint: string, description: string, url: string): string {
  const head = kind === 'triggered' ? `ALERT: ${endpoint} is failing` : `RESOLVED: ${endpoint} recovered`;
  return [`[Gatus] ${head}`, description && `Details: ${description}`, url && `URL: ${url}`]
    .filter(Boolean)
    .join('\n');
}

async function handle(body: Record<string, unknown>): Promise<string> {
  const endpoint = String(body.endpoint ?? 'unknown').slice(0, 100);
  const status = body.status === 'resolved' ? 'resolved' : 'triggered';
  const description = String(body.description ?? '').slice(0, 500);
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
    lastTriggered.set(endpoint, Date.now());
    await sendToAgent(format('triggered', endpoint, description, url));
    return 'sent';
  }

  if (pendingResolve.has(endpoint)) return 'resolve-already-pending';
  pendingResolve.set(
    endpoint,
    setTimeout(() => {
      pendingResolve.delete(endpoint);
      lastTriggered.delete(endpoint);
      sendToAgent(format('resolved', endpoint, description, url)).catch((e) =>
        console.error('resolve send failed', e),
      );
    }, RESOLVE_MS),
  );
  return 'resolve-queued';
}

http
  .createServer((req, res) => {
    const reply = (code: number, msg: string) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(msg + '\n');
    };
    if (req.method !== 'POST' || req.url !== '/alert') return reply(404, 'not found');
    if (!safeEqual(String(req.headers['x-webhook-secret'] ?? ''), SECRET)) return reply(401, 'unauthorized');
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
