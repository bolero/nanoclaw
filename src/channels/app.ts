/**
 * App channel — a native phone/tablet client talking to NanoClaw over HTTP.
 *
 * The host runs a small JSON + Server-Sent-Events API on a loopback port
 * (APP_CHANNEL_PORT, off when unset). Publish it privately, e.g. with
 * `tailscale serve`, which provides the TLS certificate iOS requires; the
 * adapter itself never listens on a public interface by default.
 *
 * Model:
 *  - A person pairs a device with a one-time code (`ncl app pair --user <handle>`)
 *    and gets a revocable bearer token; the device acts as NanoClaw user
 *    `app:<handle>`. Roles and memberships work exactly as on other channels.
 *  - Each conversation is a DM-shaped messaging group: `app:<handle>` (Home,
 *    also where approvals and cold DMs land) and `app:<handle>:<agentFolder>`
 *    for a direct chat with one agent. `ncl app connect` creates and wires them.
 *  - Every message in and out is mirrored into the channel's own store
 *    (data/app-channel/) so phones can sync history and catch up after being
 *    offline. Agents write full Markdown; files are served back over the API.
 *  - ask_question cards (approvals, agent questions) become native buttons;
 *    taps return through onAction like any other channel.
 *
 * See src/channels/app/http.ts for the API, docs/app-channel.md for setup.
 */
import os from 'os';
import path from 'path';

import { TIMEZONE } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByChannel,
} from '../db/messaging-groups.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getUser } from '../modules/permissions/db/users.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { normalizeOptions, type RawOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createAppHttpServer, EventHub, type AppApiDeps, type ConversationSummary } from './app/http.js';
import { conversationOwner, parseConversationId } from './app/ids.js';
import { getAppStore } from './app/instance.js';
import {
  ApnsClient,
  decidePush,
  isDeadToken,
  parseQuietHours,
  previewLine,
  type ApnsResult,
  type PushConfig,
} from './app/push.js';
import { newId, type AppMessage, type AppStore, type CardData, type FileRef } from './app/store.js';
import './app/commands.js';

export const APP_CHANNEL = 'app';

/**
 * Every conversation is a private 1:1 between a paired person and their
 * agent(s): every message engages, senders are checked against the wiring
 * (strict — the device token already proves who is talking), no threads.
 */
export const APP_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

const ENV_KEYS = [
  'APP_CHANNEL_PORT',
  'APP_CHANNEL_HOST',
  'APP_CHANNEL_PUBLIC_URL',
  'APP_APNS_KEY_FILE',
  'APP_APNS_KEY_ID',
  'APP_APNS_TEAM_ID',
  'APP_APNS_TOPIC',
  'APP_PUSH_QUIET_HOURS',
  'APP_PUSH_URGENT_AGENTS',
];

export interface AppChannelConfig {
  port: number;
  host: string;
  publicUrl: string | null;
  /** Push is on only when the APNs key file, key id, team id and topic are all set. */
  push?: PushConfig | null;
}

/** What delivery needs from APNs; ApnsClient in production, a stub in tests. */
export interface PushSender {
  send(
    token: string,
    env: 'development' | 'production',
    payload: Record<string, unknown>,
    opts?: { collapseId?: string; priority?: 5 | 10 },
  ): Promise<ApnsResult>;
  close(): void;
}

export function readAppChannelConfig(): AppChannelConfig | null {
  const env = readEnvFile(ENV_KEYS);
  const rawPort = process.env.APP_CHANNEL_PORT || env.APP_CHANNEL_PORT;
  if (!rawPort) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid APP_CHANNEL_PORT ${JSON.stringify(rawPort)}`);
  }
  const get = (k: string): string | undefined => process.env[k] || env[k] || undefined;
  const keyFile = get('APP_APNS_KEY_FILE');
  const keyId = get('APP_APNS_KEY_ID');
  const teamId = get('APP_APNS_TEAM_ID');
  const topic = get('APP_APNS_TOPIC');
  const push: PushConfig | null =
    keyFile && keyId && teamId && topic
      ? {
          keyFile: keyFile.replace(/^~(?=\/)/, os.homedir()),
          keyId,
          teamId,
          topic,
          quietHours: parseQuietHours(get('APP_PUSH_QUIET_HOURS')),
          urgentAgents: (get('APP_PUSH_URGENT_AGENTS') ?? '')
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          timezone: TIMEZONE,
        }
      : null;
  return {
    port,
    host: get('APP_CHANNEL_HOST') || '127.0.0.1',
    publicUrl: (get('APP_CHANNEL_PUBLIC_URL') || '').replace(/\/+$/, '') || null,
    push,
  };
}

/** Plain text of an outbound message, tolerant of the shapes delivery produces. */
function outboundText(content: Record<string, unknown>): string {
  if (typeof content.text === 'string') return content.text;
  if (typeof content.markdown === 'string') return content.markdown;
  return '';
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function createAppAdapter(
  config: AppChannelConfig,
  store: AppStore = getAppStore(),
  pushSender?: PushSender | null,
): ChannelAdapter {
  const hub = new EventHub();
  let setupConfig: ChannelSetup | null = null;
  let server: ReturnType<typeof createAppHttpServer> | null = null;
  let push: PushSender | null = pushSender ?? null;

  /** The agents answering a conversation, highest priority first. */
  async function conversationAgents(conversationId: string): Promise<Array<{ folder: string; name: string }>> {
    const mg = await getMessagingGroupByPlatform(APP_CHANNEL, conversationId);
    if (!mg) return [];
    const wirings = (await getMessagingGroupAgents(mg.id)).sort((a, b) => b.priority - a.priority);
    const out: Array<{ folder: string; name: string }> = [];
    for (const w of wirings) {
      const ag = await getAgentGroup(w.agent_group_id);
      if (ag) out.push({ folder: ag.folder, name: ag.name });
    }
    return out;
  }

  async function notify(message: AppMessage): Promise<void> {
    if (!push || !config.push) return;
    // A device with the app open already shows the message; the others still get it.
    const targets = store.pushTargets(message.userHandle).filter((d) => !hub.isDeviceLive(d.id));
    if (targets.length === 0) return;
    const agent = (await conversationAgents(message.conversationId))[0] ?? null;
    const decision = decidePush({
      isCard: message.kind === 'card',
      lastInboundAt: store.lastInboundAt(message.conversationId),
      createdAt: message.createdAt,
      live: false,
      agentFolder: agent?.folder ?? null,
      config: config.push,
    });
    if (!decision.send) {
      log.debug('App push skipped', { reason: decision.reason });
      return;
    }
    const title = agent?.name ?? 'Bono';
    const body =
      message.kind === 'card' && message.card
        ? previewLine(`${message.card.title}: ${message.card.question}`)
        : previewLine(message.text) || (message.files.length ? 'Sent an attachment' : 'New message');
    const payload = {
      aps: {
        alert: { title, body },
        badge: store.countOpenCards(message.userHandle),
        sound: decision.level === 'passive' ? undefined : 'default',
        'thread-id': message.conversationId,
        'interruption-level': decision.level,
      },
      conversationId: message.conversationId,
      messageId: message.id,
    };
    for (const device of targets) {
      const result = await push.send(device.apnsToken!, device.apnsEnv ?? 'development', payload, {
        collapseId: message.id,
        priority: decision.level === 'passive' ? 5 : 10,
      });
      if (result.ok) continue;
      if (isDeadToken(result)) store.clearApnsToken(device.apnsToken!);
      log.warn('App push failed', { deviceId: device.id, status: result.status, reason: result.reason });
    }
  }

  async function conversationExists(conversationId: string): Promise<boolean> {
    const mg = await getMessagingGroupByPlatform(APP_CHANNEL, conversationId);
    if (!mg) return false;
    return (await getMessagingGroupAgents(mg.id)).length > 0;
  }

  async function listConversations(handle: string): Promise<ConversationSummary[]> {
    const mgs = (await getMessagingGroupsByChannel(APP_CHANNEL)).filter(
      (mg) => conversationOwner(mg.platform_id) === handle,
    );
    const out: ConversationSummary[] = [];
    for (const mg of mgs) {
      const wirings = (await getMessagingGroupAgents(mg.id)).sort((a, b) => b.priority - a.priority);
      if (wirings.length === 0) continue;
      const agents: ConversationSummary['agents'] = [];
      for (const w of wirings) {
        const ag = await getAgentGroup(w.agent_group_id);
        if (!ag) continue;
        const meta = store.getAgentMeta(ag.folder);
        agents.push({
          folder: ag.folder,
          name: ag.name,
          color: meta?.color ?? null,
          avatarUrl: meta?.avatarFile
            ? `/v1/agents/${encodeURIComponent(ag.folder)}/avatar?v=${encodeURIComponent(meta.updatedAt)}`
            : null,
        });
      }
      const parsed = parseConversationId(mg.platform_id);
      const kind = parsed?.folder ? 'agent' : 'home';
      out.push({
        id: mg.platform_id,
        kind,
        title: kind === 'home' ? 'Home' : (agents[0]?.name ?? parsed?.folder ?? mg.platform_id),
        agents,
        lastMessage: store.lastMessage(mg.platform_id),
      });
    }
    // Home first, then most recently active.
    return out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'home' ? -1 : 1;
      return (b.lastMessage?.createdAt ?? '').localeCompare(a.lastMessage?.createdAt ?? '');
    });
  }

  const deps: AppApiDeps = {
    store,
    listConversations,
    conversationExists,

    async userDisplayName(handle) {
      return (await getUser(`app:${handle}`))?.display_name ?? null;
    },

    async sendInbound(device, conversationId, text, attachments, clientId) {
      if (!setupConfig) throw new Error('app channel not set up');
      const id = clientId ? `in_${device.id}_${clientId}` : newId('in');
      const existing = store.getMessage(id);
      if (existing) return existing; // client retry — already accepted

      const senderName = (await getUser(`app:${device.userHandle}`))?.display_name ?? device.userHandle;
      const files: FileRef[] = attachments.map((a) =>
        store.saveFile(id, device.userHandle, a.name, a.mimeType, a.data),
      );
      const message = store.insertMessage({
        id,
        conversationId,
        userHandle: device.userHandle,
        direction: 'in',
        kind: 'text',
        text,
        card: null,
        files,
        senderName,
        failure: false,
      });
      hub.publishMessage(message);

      await setupConfig.onInbound(conversationId, null, {
        id,
        kind: 'chat',
        timestamp: message.createdAt,
        isMention: true,
        isGroup: false,
        content: {
          text,
          sender: senderName,
          senderId: `app:${device.userHandle}`,
          senderName,
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  type: a.mimeType.startsWith('image/') ? 'image' : 'file',
                  name: a.name,
                  mimeType: a.mimeType,
                  size: a.data.length,
                  data: a.data.toString('base64'),
                })),
              }
            : {}),
        },
      });
      return message;
    },

    async answerCard(device, message, value) {
      if (!setupConfig) throw new Error('app channel not set up');
      const card = message.card!;
      const option = card.options.find((o) => o.value === value)!;
      const senderName = (await getUser(`app:${device.userHandle}`))?.display_name ?? device.userHandle;
      setupConfig.onAction(card.questionId, value, `app:${device.userHandle}`, {
        messageId: message.id,
        platformId: message.conversationId,
        threadId: null,
      });
      // Show the answer right away, like the chat-sdk bridge does; a terminal
      // edit from the host (approvals) replaces the resolution text later.
      const updated = store.updateMessage(message.id, {
        card: {
          ...card,
          resolution: `${option.selectedLabel} by ${senderName}`,
          answeredBy: `app:${device.userHandle}`,
          answeredAt: new Date().toISOString(),
        },
      })!;
      hub.publishMessage(updated);
      return updated;
    },
  };

  const adapter: ChannelAdapter = {
    name: APP_CHANNEL,
    channelType: APP_CHANNEL,
    supportsThreads: false,
    defaults: APP_DEFAULTS,

    async setup(cfg: ChannelSetup): Promise<void> {
      setupConfig = cfg;
      store.pruneCodes();
      server = createAppHttpServer(deps, hub);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(config.port, config.host, () => {
          server!.off('error', reject);
          resolve();
        });
      });
      if (!push && config.push) {
        try {
          push = new ApnsClient(config.push);
          // eslint-disable-next-line no-catch-all/no-catch-all -- a bad key turns push off; the channel still runs
        } catch (err) {
          log.error('App channel: APNs key could not be loaded, push is off', { err });
        }
      }
      log.info('App channel listening', { host: config.host, port: config.port, push: push !== null });
    },

    async teardown(): Promise<void> {
      hub.closeAll();
      if (!pushSender) {
        push?.close();
        push = null;
      }
      if (server) {
        const s = server;
        server = null;
        await new Promise<void>((resolve) => s.close(() => resolve()));
        s.closeAllConnections?.();
      }
      setupConfig = null;
    },

    isConnected(): boolean {
      return server?.listening ?? false;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const parsed = parseConversationId(platformId);
      if (!parsed) {
        log.warn('App channel: refusing delivery to a malformed conversation id');
        return undefined;
      }
      const content = (message.content ?? {}) as Record<string, unknown>;

      if (content.operation === 'edit' && typeof content.messageId === 'string') {
        const existing = store.getMessage(content.messageId);
        if (!existing || existing.conversationId !== platformId) return undefined;
        const terminal = content.terminalCard as { resolution?: unknown } | undefined;
        let updated: AppMessage | null;
        if (existing.card && terminal && typeof terminal.resolution === 'string') {
          updated = store.updateMessage(existing.id, { card: { ...existing.card, resolution: terminal.resolution } });
        } else {
          updated = store.updateMessage(existing.id, { text: outboundText(content) });
        }
        if (updated) hub.publishMessage(updated);
        return undefined;
      }

      if (content.operation === 'reaction') return undefined; // no reactions in the app yet

      const id = newId('out');
      let card: CardData | null = null;
      let text = outboundText(content);
      if (content.type === 'ask_question') {
        if (
          typeof content.questionId !== 'string' ||
          typeof content.title !== 'string' ||
          !Array.isArray(content.options)
        ) {
          throw new Error('ask_question card is missing questionId, title or options');
        }
        card = {
          questionId: content.questionId,
          title: content.title,
          question: typeof content.question === 'string' ? content.question : '',
          options: normalizeOptions(content.options as RawOption[]),
        };
        text = card.question;
      }

      const files: FileRef[] = (message.files ?? []).map((f) =>
        store.saveFile(id, parsed.handle, f.filename, guessMime(f.filename), f.data),
      );
      if (!text && !card && files.length === 0) return undefined;

      const stored = store.insertMessage({
        id,
        conversationId: platformId,
        userHandle: parsed.handle,
        direction: 'out',
        kind: card ? 'card' : 'text',
        text,
        card,
        files,
        senderName: typeof content.sender === 'string' ? content.sender : null,
        failure: content.failureNotice === true,
      });
      hub.publishMessage(stored);
      hub.publishTyping(parsed.handle, platformId, null);
      notify(stored).catch((err) => log.warn('App push threw', { err }));
      return id;
    },

    async setTyping(platformId, _threadId, status): Promise<void> {
      const owner = conversationOwner(platformId);
      if (owner) hub.publishTyping(owner, platformId, status ?? 'typing');
    },

    /** Home conversation id for a user handle — approvals and cold DMs land there. */
    async openDM(userHandle: string): Promise<string> {
      return `app:${userHandle}`;
    },
  };

  return adapter;
}

registerChannelAdapter(APP_CHANNEL, {
  factory: () => {
    const config = readAppChannelConfig();
    if (!config) return null;
    return createAppAdapter(config);
  },
  defaults: APP_DEFAULTS,
});
