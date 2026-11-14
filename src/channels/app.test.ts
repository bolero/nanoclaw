/* eslint-disable @typescript-eslint/no-explicit-any, no-catch-all/no-catch-all -- test helpers parse loose JSON */
/**
 * App channel end to end: ncl wiring + pairing → HTTP API → router hand-off,
 * outbound delivery → sync/feed/SSE, cards → onAction → terminal edit, and
 * the per-user isolation the token gives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { createAppAdapter } from './app.js';
import { agentConversationId, parseConversationId, parseHandle } from './app/ids.js';
import { setAppStoreForTests } from './app/instance.js';
import { AppStore } from './app/store.js';
import { lookup } from '../cli/registry.js';
import { allocateFreePort } from '../test-utils/free-port.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-app-channel-'));
let store: AppStore;
let adapter: ChannelAdapter;
let base: string;

const inbound: Array<{ platformId: string; message: InboundMessage }> = [];
const actions: Array<{ questionId: string; value: string; userId: string; messageId?: string }> = [];

const setup: ChannelSetup = {
  onInbound(platformId, _threadId, message) {
    inbound.push({ platformId, message });
  },
  onInboundEvent() {},
  onMetadata() {},
  onAction(questionId, value, userId, address) {
    actions.push({ questionId, value, userId, messageId: address?.messageId });
  },
};

async function ncl(name: string, args: Record<string, unknown>): Promise<unknown> {
  const def = lookup(name);
  if (!def) throw new Error(`no command ${name}`);
  return def.handler(def.parseArgs(args), { caller: 'host' });
}

async function api(
  token: string | null,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function pair(handle: string, name: string): Promise<string> {
  const { code } = (await ncl('app-pair', { user: handle, name })) as { code: string };
  const res = await api(null, 'POST', '/v1/pair', { code: code.toLowerCase(), deviceName: `${name}'s phone` });
  expect(res.status).toBe(200);
  return res.json.token as string;
}

beforeAll(async () => {
  const { initTestDb, runMigrations } = await import('../db/index.js');
  const db = await initTestDb();
  await runMigrations(db);
  const { createAgentGroup } = await import('../db/agent-groups.js');
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-bono', name: 'Bono', folder: 'bono', agent_provider: null, created_at: now });
  await createAgentGroup({ id: 'ag-family', name: 'Family', folder: 'family', agent_provider: null, created_at: now });

  store = new AppStore(dir);
  setAppStoreForTests(store);
  const port = await allocateFreePort('127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  adapter = createAppAdapter({ port, host: '127.0.0.1', publicUrl: null }, store);
  await adapter.setup(setup);
});

afterAll(async () => {
  await adapter.teardown();
  setAppStoreForTests(null);
  store.close();
  const { closeDb } = await import('../db/index.js');
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ids', () => {
  it('parses home and agent conversations and rejects anything else', () => {
    expect(parseConversationId('app:alex')).toEqual({ handle: 'alex', folder: null });
    expect(parseConversationId(agentConversationId('alex', 'family'))).toEqual({ handle: 'alex', folder: 'family' });
    expect(parseConversationId('telegram:1')).toBeNull();
    expect(parseConversationId('app:Alex')).toBeNull();
    expect(parseConversationId('app:alex:fam:x')).toBeNull();
    expect(parseHandle('app:alex')).toBe('alex');
    expect(parseHandle('../x')).toBeNull();
  });
});

describe('app channel', () => {
  let alex: string;
  let bob: string;

  it('wires conversations and pairs devices with one-time codes', async () => {
    const home = (await ncl('app-connect', { user: 'alex', agent: 'bono', home: true })) as {
      conversation: string;
      wired: boolean;
    };
    expect(home).toMatchObject({ conversation: 'app:alex', wired: true });
    expect(await ncl('app-connect', { user: 'alex', agent: 'bono', home: true })).toMatchObject({ wired: false });
    await ncl('app-connect', { user: 'alex', agent: 'family' });
    await ncl('app-connect', { user: 'bob', agent: 'family' });

    alex = await pair('alex', 'Alex');
    bob = await pair('bob', 'Bob');

    // A code works once.
    const { code } = (await ncl('app-pair', { user: 'alex' })) as { code: string };
    expect((await api(null, 'POST', '/v1/pair', { code })).status).toBe(200);
    expect((await api(null, 'POST', '/v1/pair', { code })).status).toBe(401);

    const me = await api(alex, 'GET', '/v1/me');
    expect(me.json.user).toEqual({ id: 'app:alex', handle: 'alex', name: 'Alex' });
  });

  it("lists only the caller's conversations, Home first", async () => {
    const res = await api(alex, 'GET', '/v1/conversations');
    expect(res.json.conversations.map((c: { id: string }) => c.id)).toEqual(['app:alex', 'app:alex:family']);
    expect(res.json.conversations[0]).toMatchObject({
      kind: 'home',
      title: 'Home',
      agents: [{ folder: 'bono', name: 'Bono' }],
    });
    const bobs = await api(bob, 'GET', '/v1/conversations');
    expect(bobs.json.conversations.map((c: { id: string }) => c.id)).toEqual(['app:bob:family']);
  });

  it('hands sent messages to the router as the paired user, with attachments', async () => {
    const res = await api(alex, 'POST', '/v1/conversations/app%3Aalex/messages', {
      text: 'receipt attached',
      clientId: 'c1',
      attachments: [{ name: 'r.jpg', mimeType: 'image/jpeg', data: Buffer.from('jpegbytes').toString('base64') }],
    });
    expect(res.status).toBe(200);
    expect(inbound).toHaveLength(1);
    const content = inbound[0]!.message.content as Record<string, any>;
    expect(inbound[0]!.platformId).toBe('app:alex');
    expect(content).toMatchObject({ text: 'receipt attached', senderId: 'app:alex', senderName: 'Alex' });
    expect(Buffer.from(content.attachments[0].data, 'base64').toString()).toBe('jpegbytes');

    // Retrying with the same clientId does not send twice.
    await api(alex, 'POST', '/v1/conversations/app%3Aalex/messages', { text: 'receipt attached', clientId: 'c1' });
    expect(inbound).toHaveLength(1);

    // Another user's conversation is invisible.
    expect((await api(bob, 'POST', '/v1/conversations/app%3Aalex/messages', { text: 'hi' })).status).toBe(404);
    expect((await api(bob, 'GET', '/v1/conversations/app%3Aalex/messages')).status).toBe(404);
  });

  it('stores outbound messages and files for sync, and streams them over SSE', async () => {
    const controller = new AbortController();
    const sse = await fetch(`${base}/v1/events`, {
      headers: { Authorization: `Bearer ${alex}` },
      signal: controller.signal,
    });
    const reader = sse.body!.getReader();

    const id = await adapter.deliver('app:alex', null, {
      kind: 'chat',
      content: { text: '## Done\n- filed' },
      files: [{ filename: 'chart.png', data: Buffer.from('pngbytes') }],
    });
    expect(id).toMatch(/^out_/);

    let received = '';
    while (!received.includes('## Done')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(received).toContain('event: message');

    const sync = await api(alex, 'GET', '/v1/sync?after=0');
    const out = sync.json.messages.find((m: { id: string }) => m.id === id);
    expect(out).toMatchObject({ direction: 'out', text: '## Done\n- filed', conversationId: 'app:alex' });
    const file = await fetch(`${base}/v1/files/${out.files[0].id}`, { headers: { Authorization: `Bearer ${alex}` } });
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(await file.text()).toBe('pngbytes');
    expect(
      (await fetch(`${base}/v1/files/${out.files[0].id}`, { headers: { Authorization: `Bearer ${bob}` } })).status,
    ).toBe(404);
  });

  it('turns ask_question into a pinned card whose tap goes to onAction', async () => {
    const id = await adapter.deliver('app:alex', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q1',
        title: 'Deploy?',
        question: 'Ship it?',
        options: ['Approve', { label: 'Reject', value: 'no' }],
      },
    });
    const feed = await api(alex, 'GET', '/v1/feed');
    expect(feed.json.needsYou.map((m: { id: string }) => m.id)).toEqual([id]);

    expect((await api(alex, 'POST', '/v1/actions', { messageId: id, value: 'maybe' })).status).toBe(400);
    expect((await api(bob, 'POST', '/v1/actions', { messageId: id, value: 'no' })).status).toBe(404);
    const answered = await api(alex, 'POST', '/v1/actions', { messageId: id, value: 'no' });
    expect(answered.json.message.card.resolution).toBe('Reject by Alex');
    expect(actions).toEqual([{ questionId: 'q1', value: 'no', userId: 'app:alex', messageId: id }]);
    expect((await api(alex, 'POST', '/v1/actions', { messageId: id, value: 'no' })).status).toBe(409);
    expect((await api(alex, 'GET', '/v1/feed')).json.needsYou).toEqual([]);

    await adapter.deliver('app:alex', null, {
      kind: 'chat',
      content: {
        operation: 'edit',
        messageId: id,
        terminalCard: { title: 'Deploy?', question: 'Ship it?', resolution: 'Rejected' },
      },
    });
    expect(store.getMessage(id!)!.card!.resolution).toBe('Rejected');
  });

  it('rejects revoked and unknown tokens', async () => {
    expect((await api('nope', 'GET', '/v1/me')).status).toBe(401);
    const device = store.listDevices('bob')[0]!;
    await ncl('app-revoke', { id: device.id });
    expect((await api(bob, 'GET', '/v1/me')).status).toBe(401);
  });

  it('returns the Home conversation for cold DMs', async () => {
    expect(await adapter.openDM!('alex')).toBe('app:alex');
  });
});

describe('app channel push', () => {
  const sent: Array<{ token: string; env: string; payload: any }> = [];
  let pushAdapter: ChannelAdapter;

  beforeAll(async () => {
    const port = await allocateFreePort('127.0.0.1');
    pushAdapter = createAppAdapter(
      {
        port,
        host: '127.0.0.1',
        publicUrl: null,
        push: { keyFile: '', keyId: 'K', teamId: 'T', topic: 'x', quietHours: null, urgentAgents: [], timezone: 'UTC' },
      },
      store,
      {
        async send(token, env, payload) {
          sent.push({ token, env, payload });
          return token === 'dead'.repeat(16) ? { ok: false, status: 410 } : { ok: true, status: 200 };
        },
        close() {},
      },
    );
    await pushAdapter.setup(setup);
    const alexDevice = store.listDevices('alex').find((d) => !d.revokedAt)!;
    store.setApnsToken(alexDevice.id, 'ab'.repeat(32), 'development');
  });

  afterAll(async () => {
    await pushAdapter.teardown();
  });

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
  }

  it('pushes when an agent speaks first, with agent name and a clean first line', async () => {
    sent.length = 0;
    await pushAdapter.deliver('app:alex:family', null, {
      kind: 'chat',
      content: { text: '## School\nConcert on Thursday' },
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env).toBe('development');
    expect(sent[0]!.payload.aps).toMatchObject({
      alert: { title: 'Family', body: 'School' },
      'thread-id': 'app:alex:family',
      'interruption-level': 'active',
    });
    expect(sent[0]!.payload.conversationId).toBe('app:alex:family');
  });

  it('stays quiet for replies, but always pushes a card with the open-card badge', async () => {
    sent.length = 0;
    await pushAdapter.deliver('app:alex', null, { kind: 'chat', content: { text: 'Done.' } });
    await settle();
    expect(sent).toHaveLength(0);
    await pushAdapter.deliver('app:alex', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-push',
        title: 'Restart?',
        question: 'Restart gatus?',
        options: ['Yes', 'No'],
      },
    });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.aps.alert).toEqual({ title: 'Bono', body: 'Restart?: Restart gatus?' });
    expect(sent[0]!.payload.aps.badge).toBe(1);
  });

  it('drops a token APNs says is gone', async () => {
    const alexDevice = store.listDevices('alex').find((d) => !d.revokedAt)!;
    store.setApnsToken(alexDevice.id, 'dead'.repeat(16), 'production');
    await pushAdapter.deliver('app:alex:family', null, { kind: 'chat', content: { text: 'Another update' } });
    await settle();
    expect(store.listDevices('alex').find((d) => d.id === alexDevice.id)!.apnsToken).toBeNull();
  });
});
