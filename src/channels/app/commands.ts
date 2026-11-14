/**
 * `ncl app …` — operator commands for the app channel. Host-only: an agent can
 * never pair devices, wire conversations or change avatars.
 *
 *   ncl app pair --user <handle> [--name <display name>]
 *   ncl app connect --user <handle> --agent <folder> [--home]
 *   ncl app devices [--user <handle>]
 *   ncl app revoke --id <device id>
 *   ncl app avatar --agent <folder> [--file <image>] [--color <#rrggbb>]
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { register } from '../../cli/registry.js';
import { readEnvFile } from '../../env.js';
import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { resolveWiringDefaults } from '../channel-defaults.js';
import { agentConversationId, FOLDER_RE, homeConversationId, parseHandle } from './ids.js';
import { getAppStore } from './instance.js';

const CHANNEL = 'app';

function str(raw: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null || v === true) {
    if (required) throw new Error(`--${key} is required`);
    return undefined;
  }
  return String(v);
}

function handleArg(raw: Record<string, unknown>): string {
  const h = parseHandle(str(raw, 'user')!);
  if (!h) throw new Error('--user must be a handle like "alex" (lowercase letters, digits, dashes; max 32)');
  return h;
}

function publicUrl(): string | null {
  const v = process.env.APP_CHANNEL_PUBLIC_URL || readEnvFile(['APP_CHANNEL_PUBLIC_URL']).APP_CHANNEL_PUBLIC_URL;
  return v ? v.replace(/\/+$/, '') : null;
}

register({
  name: 'app-pair',
  description:
    'Create a one-time pairing code (10 minutes) for a person\'s phone or tablet. Creates the user app:<handle> if needed. Usage: ncl app pair --user <handle> [--name "Display Name"]',
  access: 'open',
  hostOnly: true,
  resource: 'app',
  parseArgs: (raw) => ({ handle: handleArg(raw), name: str(raw, 'name', false) ?? null }),
  handler: async ({ handle, name }: { handle: string; name: string | null }) => {
    await upsertUser({ id: `app:${handle}`, kind: CHANNEL, display_name: name, created_at: new Date().toISOString() });
    const { code, expiresAt } = getAppStore().createPairCode(handle, name);
    const server = publicUrl();
    const link = server ? `bono://pair?server=${encodeURIComponent(server)}&code=${code}` : null;
    return { user: `app:${handle}`, code, expiresAt, server, link };
  },
  formatHuman: (d: { user: string; code: string; expiresAt: string; server: string | null; link: string | null }) =>
    [
      `Pairing code for ${d.user}: ${d.code}`,
      `Expires: ${d.expiresAt}`,
      d.server ? `Server: ${d.server}` : 'Server: (set APP_CHANNEL_PUBLIC_URL to include it)',
      d.link ? `Link (render as QR, e.g. qrencode -t ansiutf8 '<link>'): ${d.link}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
});

register({
  name: 'app-connect',
  description:
    "Create and wire an app conversation: --home makes the person's Home chat (approvals land there) answered by --agent; otherwise a direct chat with that agent. Also adds the person as a member of the agent group. Usage: ncl app connect --user <handle> --agent <folder> [--home]",
  access: 'open',
  hostOnly: true,
  resource: 'app',
  parseArgs: (raw) => {
    const folder = str(raw, 'agent')!;
    if (!FOLDER_RE.test(folder)) throw new Error('--agent must be an agent group folder');
    return { handle: handleArg(raw), folder, home: raw.home === true || raw.home === 'true' };
  },
  handler: async ({ handle, folder, home }: { handle: string; folder: string; home: boolean }) => {
    const ag = await getAgentGroupByFolder(folder);
    if (!ag) throw new Error(`agent group not found: ${folder}`);
    const now = new Date().toISOString();
    const userId = `app:${handle}`;
    await upsertUser({ id: userId, kind: CHANNEL, display_name: null, created_at: now });

    const platformId = home ? homeConversationId(handle) : agentConversationId(handle, folder);
    let mg = await getMessagingGroupByPlatform(CHANNEL, platformId);
    if (!mg) {
      mg = {
        id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel_type: CHANNEL,
        platform_id: platformId,
        instance: CHANNEL,
        // Becomes the agent's destination name (app-<handle>-home), which tells it the message came from the app.
        name: home ? `app ${handle} home` : `app ${handle} ${ag.name}`,
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: now,
      };
      await createMessagingGroup(mg);
    }

    let wired = false;
    if (!(await getMessagingGroupAgentByPair(mg.id, ag.id))) {
      const defaults = resolveWiringDefaults(CHANNEL, false, ag.name, CHANNEL);
      await createMessagingGroupAgent({
        id: randomUUID(),
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: defaults.engage_mode,
        engage_pattern: defaults.engage_pattern,
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: defaults.session_mode,
        priority: 0,
        created_at: now,
      });
      await projectDestinationsToSessions(ag.id);
      wired = true;
    }
    await addMember({ user_id: userId, agent_group_id: ag.id, added_by: null, added_at: now });
    return { conversation: platformId, messagingGroupId: mg.id, agent: folder, wired };
  },
});

register({
  name: 'app-devices',
  description: 'List paired app devices. Usage: ncl app devices [--user <handle>]',
  access: 'open',
  hostOnly: true,
  resource: 'app',
  parseArgs: (raw) => {
    const u = str(raw, 'user', false);
    const handle = u ? parseHandle(u) : null;
    if (u && !handle) throw new Error('invalid --user');
    return { handle };
  },
  handler: async ({ handle }: { handle: string | null }) =>
    getAppStore()
      .listDevices(handle ?? undefined)
      .map((d) => ({
        id: d.id,
        user: `app:${d.userHandle}`,
        name: d.name,
        created_at: d.createdAt,
        last_seen_at: d.lastSeenAt,
        revoked_at: d.revokedAt,
        push: d.apnsToken !== null,
      })),
});

register({
  name: 'app-revoke',
  description: 'Revoke a paired device; its token stops working immediately. Usage: ncl app revoke --id <device id>',
  access: 'open',
  hostOnly: true,
  resource: 'app',
  parseArgs: (raw) => ({ id: str(raw, 'id')! }),
  handler: async ({ id }: { id: string }) => {
    if (!getAppStore().revokeDevice(id)) throw new Error(`no active device ${id}`);
    return { revoked: id };
  },
});

register({
  name: 'app-avatar',
  description:
    "Set an agent's avatar image (PNG/JPEG/WebP/SVG, square works best) and/or accent colour shown in the app. Usage: ncl app avatar --agent <folder> [--file <path>] [--color #rrggbb]",
  access: 'open',
  hostOnly: true,
  resource: 'app',
  parseArgs: (raw) => {
    const folder = str(raw, 'agent')!;
    if (!FOLDER_RE.test(folder)) throw new Error('--agent must be an agent group folder');
    const file = str(raw, 'file', false);
    const color = str(raw, 'color', false);
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('--color must look like #3b82f6');
    if (!file && !color) throw new Error('give --file and/or --color');
    return { folder, file, color };
  },
  handler: async ({ folder, file, color }: { folder: string; file?: string; color?: string }) => {
    if (!(await getAgentGroupByFolder(folder))) throw new Error(`agent group not found: ${folder}`);
    const store = getAppStore();
    let avatarFile: string | undefined;
    if (file) {
      const ext = path.extname(file).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext))
        throw new Error('avatar must be .png, .jpg, .webp or .svg');
      const data = fs.readFileSync(file);
      if (data.length > 5 * 1024 * 1024) throw new Error('avatar larger than 5 MB');
      avatarFile = `${folder}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(store.avatarsDir, avatarFile), data, { mode: 0o600 });
      const previous = store.getAgentMeta(folder)?.avatarFile;
      if (previous) fs.rmSync(path.join(store.avatarsDir, path.basename(previous)), { force: true });
    }
    return store.setAgentMeta(folder, { avatarFile, color });
  },
});
