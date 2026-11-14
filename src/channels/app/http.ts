/**
 * App channel HTTP API.
 *
 * Plain HTTP on a loopback port; publish it with `tailscale serve` (which
 * terminates TLS with a real *.ts.net certificate). Every route except
 * /v1/health and /v1/pair needs `Authorization: Bearer <device token>`.
 *
 *   GET  /v1/health                       → { ok }
 *   POST /v1/pair                         { code, deviceName } → { token, deviceId, user }
 *   GET  /v1/me                           → { user, device }
 *   GET  /v1/conversations                → { conversations: [...] }
 *   GET  /v1/conversations/:id/messages   ?before=<iso>&limit= → { messages } (newest first)
 *   POST /v1/conversations/:id/messages   { text, clientId?, attachments?: [{ name, mimeType, data(base64) }] }
 *   GET  /v1/feed                         ?before=<iso>&limit= → { needsYou, messages }
 *   GET  /v1/sync                         ?after=<rev>&limit= → { messages, rev, more }
 *   POST /v1/actions                      { messageId, value } → { message }
 *   GET  /v1/events                       SSE: message | typing events; honours Last-Event-ID / ?after=
 *   GET  /v1/files/:id                    raw bytes
 *   GET  /v1/agents/:folder/avatar        image bytes (404 when none set)
 *   PUT  /v1/devices/me/push              { apnsToken | null, environment: development|production }
 *
 * Conversation ids are the channel's platform ids (see ./ids.ts) and are
 * always checked against the caller's own handle.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { log } from '../../log.js';
import { conversationOwner } from './ids.js';
import type { AppMessage, AppStore, Device } from './store.js';

export interface ConversationSummary {
  id: string;
  kind: 'home' | 'agent';
  title: string;
  agents: Array<{ folder: string; name: string; color: string | null; avatarUrl: string | null }>;
  lastMessage: AppMessage | null;
}

export interface UploadedAttachment {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** What the HTTP layer needs from the adapter; injected so tests can stub it. */
export interface AppApiDeps {
  store: AppStore;
  listConversations(userHandle: string): Promise<ConversationSummary[]>;
  /** True when this conversation is wired (exists as a messaging group with an agent). */
  conversationExists(conversationId: string): Promise<boolean>;
  userDisplayName(userHandle: string): Promise<string | null>;
  sendInbound(
    device: Device,
    conversationId: string,
    text: string,
    attachments: UploadedAttachment[],
    clientId: string | null,
  ): Promise<AppMessage>;
  answerCard(device: Device, message: AppMessage, value: string): Promise<AppMessage>;
}

export const MAX_BODY_BYTES = 30 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;
const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const PAIR_FAILURE_LIMIT = 20;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Live SSE subscribers per user handle, and which devices have the app open. */
export class EventHub {
  private readonly clients = new Map<string, Set<http.ServerResponse>>();
  private readonly liveDevices = new Map<string, number>();

  add(userHandle: string, res: http.ServerResponse, deviceId?: string): void {
    let set = this.clients.get(userHandle);
    if (!set) {
      set = new Set();
      this.clients.set(userHandle, set);
    }
    set.add(res);
    if (deviceId) this.liveDevices.set(deviceId, (this.liveDevices.get(deviceId) ?? 0) + 1);
  }

  remove(userHandle: string, res: http.ServerResponse, deviceId?: string): void {
    const set = this.clients.get(userHandle);
    set?.delete(res);
    if (set && set.size === 0) this.clients.delete(userHandle);
    if (deviceId) {
      const n = (this.liveDevices.get(deviceId) ?? 1) - 1;
      if (n > 0) this.liveDevices.set(deviceId, n);
      else this.liveDevices.delete(deviceId);
    }
  }

  /** True while this device holds an open event stream (the app is on screen). */
  isDeviceLive(deviceId: string): boolean {
    return this.liveDevices.has(deviceId);
  }

  publishMessage(message: AppMessage): void {
    this.send(message.userHandle, 'message', message, message.rev);
  }

  publishTyping(userHandle: string, conversationId: string, status: string | null): void {
    this.send(userHandle, 'typing', { conversationId, status });
  }

  hasClients(userHandle: string): boolean {
    return (this.clients.get(userHandle)?.size ?? 0) > 0;
  }

  closeAll(): void {
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
  }

  private send(userHandle: string, event: string, data: unknown, id?: number): void {
    const set = this.clients.get(userHandle);
    if (!set) return;
    const frame = `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      /* eslint-disable no-catch-all/no-catch-all -- one dead stream must not stop delivery to the others */
      try {
        res.write(frame);
      } catch (err) {
        log.debug('App SSE write failed', { err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
  }
}

export function createAppHttpServer(deps: AppApiDeps, hub: EventHub): http.Server {
  const pairFailures: number[] = [];

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://app.local');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (parts[0] !== 'v1') throw new HttpError(404, 'not found');
    const route = parts.slice(1);

    if (method === 'GET' && route[0] === 'health' && route.length === 1) {
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && route[0] === 'pair' && route.length === 1) {
      const now = Date.now();
      while (pairFailures.length && pairFailures[0]! < now - PAIR_FAILURE_WINDOW_MS) pairFailures.shift();
      if (pairFailures.length >= PAIR_FAILURE_LIMIT) throw new HttpError(429, 'too many attempts, try later');
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code : '';
      const deviceName = typeof body.deviceName === 'string' ? body.deviceName : 'device';
      const result = code ? deps.store.redeemPairCode(code, deviceName) : null;
      if (!result) {
        pairFailures.push(now);
        throw new HttpError(401, 'invalid or expired code');
      }
      log.info('App device paired', { deviceId: result.device.id, user: result.device.userHandle });
      return json(res, 200, {
        token: result.token,
        deviceId: result.device.id,
        user: await userPayload(result.device.userHandle),
      });
    }

    const device = authenticate(req);
    deps.store.touchDevice(device.id);
    const handle = device.userHandle;

    if (method === 'GET' && route[0] === 'me' && route.length === 1) {
      return json(res, 200, { user: await userPayload(handle), device: publicDevice(device) });
    }

    if (method === 'GET' && route[0] === 'conversations' && route.length === 1) {
      return json(res, 200, { conversations: await deps.listConversations(handle) });
    }

    if (route[0] === 'conversations' && route.length === 3 && route[2] === 'messages') {
      const conversationId = decodeURIComponent(route[1]!);
      if (conversationOwner(conversationId) !== handle || !(await deps.conversationExists(conversationId))) {
        throw new HttpError(404, 'no such conversation');
      }
      if (method === 'GET') {
        const messages = deps.store.conversationPage(conversationId, url.searchParams.get('before'), limitParam(url));
        return json(res, 200, { messages });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const attachments = parseAttachments(body.attachments);
        if (!text.trim() && attachments.length === 0) throw new HttpError(400, 'empty message');
        const clientId =
          typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.clientId) ? body.clientId : null;
        const message = await deps.sendInbound(device, conversationId, text, attachments, clientId);
        return json(res, 200, { message });
      }
    }

    if (method === 'GET' && route[0] === 'feed' && route.length === 1) {
      return json(res, 200, {
        needsYou: deps.store.openCards(handle),
        messages: deps.store.feedPage(handle, url.searchParams.get('before'), limitParam(url)),
      });
    }

    if (method === 'GET' && route[0] === 'sync' && route.length === 1) {
      const after = Number(url.searchParams.get('after') ?? '0') || 0;
      const limit = limitParam(url, 500);
      const messages = deps.store.syncForUser(handle, after, limit);
      const rev = messages.length ? messages[messages.length - 1]!.rev : after;
      return json(res, 200, { messages, rev, more: messages.length === limit });
    }

    if (method === 'POST' && route[0] === 'actions' && route.length === 1) {
      const body = await readJson(req);
      const messageId = typeof body.messageId === 'string' ? body.messageId : '';
      const value = typeof body.value === 'string' ? body.value : '';
      const message = deps.store.getMessage(messageId);
      if (!message || message.userHandle !== handle || message.kind !== 'card' || !message.card) {
        throw new HttpError(404, 'no such card');
      }
      if (message.card.resolution) throw new HttpError(409, 'already answered');
      if (!message.card.options.some((o) => o.value === value)) throw new HttpError(400, 'unknown option');
      return json(res, 200, { message: await deps.answerCard(device, message, value) });
    }

    if (method === 'GET' && route[0] === 'events' && route.length === 1) {
      return openEventStream(req, res, url, handle, device.id);
    }

    if (method === 'GET' && route[0] === 'files' && route.length === 2) {
      const file = deps.store.getFile(route[1]!);
      if (!file || file.userHandle !== handle) throw new HttpError(404, 'no such file');
      res.writeHead(200, {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.size),
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      fs.createReadStream(file.path).pipe(res);
      return;
    }

    if (method === 'GET' && route[0] === 'agents' && route.length === 3 && route[2] === 'avatar') {
      const meta = deps.store.getAgentMeta(decodeURIComponent(route[1]!));
      if (!meta?.avatarFile) throw new HttpError(404, 'no avatar');
      const file = path.join(deps.store.avatarsDir, path.basename(meta.avatarFile));
      if (!fs.existsSync(file)) throw new HttpError(404, 'no avatar');
      res.writeHead(200, { 'Content-Type': imageType(file), 'Cache-Control': 'private, max-age=300' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (method === 'PUT' && route[0] === 'devices' && route[1] === 'me' && route[2] === 'push' && route.length === 3) {
      const body = await readJson(req);
      const token =
        typeof body.apnsToken === 'string' && /^[0-9a-fA-F]{32,200}$/.test(body.apnsToken) ? body.apnsToken : null;
      const env = body.environment === 'production' ? 'production' : 'development';
      deps.store.setApnsToken(device.id, token, token ? env : null);
      return json(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not found');
  }

  function authenticate(req: http.IncomingMessage): Device {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(\S+)$/.exec(header);
    const device = match ? deps.store.authenticate(match[1]!) : null;
    if (!device) throw new HttpError(401, 'unauthorized');
    return device;
  }

  async function userPayload(handle: string): Promise<{ id: string; handle: string; name: string | null }> {
    return { id: `app:${handle}`, handle, name: await deps.userDisplayName(handle) };
  }

  function openEventStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    handle: string,
    deviceId: string,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    // Replay anything the client missed, then go live.
    const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 'NaN');
    if (Number.isFinite(lastId)) {
      for (const message of deps.store.syncForUser(handle, lastId, 500)) {
        res.write(`id: ${message.rev}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
      }
    }
    hub.add(handle, res, deviceId);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      hub.remove(handle, res, deviceId);
    });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) json(res, err.status, { error: err.message });
        else res.end();
        return;
      }
      log.error('App channel request failed', { method: req.method, path: req.url?.split('?')[0], err });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}

function publicDevice(d: Device): Record<string, unknown> {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, push: d.apnsToken !== null };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function limitParam(url: URL, max = 200): number {
  const raw = Number(url.searchParams.get('limit') ?? '50');
  if (!Number.isFinite(raw) || raw < 1) return 50;
  return Math.min(Math.floor(raw), max);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function parseAttachments(raw: unknown): UploadedAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10) throw new HttpError(400, 'invalid attachments');
  return raw.map((a) => {
    const obj = (a ?? {}) as Record<string, unknown>;
    if (typeof obj.data !== 'string' || typeof obj.name !== 'string') throw new HttpError(400, 'invalid attachment');
    return {
      name: obj.name.slice(0, 200),
      mimeType: typeof obj.mimeType === 'string' ? obj.mimeType.slice(0, 100) : 'application/octet-stream',
      data: Buffer.from(obj.data, 'base64'),
    };
  });
}

function imageType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}
