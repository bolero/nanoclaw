/**
 * App channel store — the channel's own SQLite file (`data/app-channel/app.db`).
 *
 * Holds what only this channel needs: paired devices (token hashes), one-time
 * pairing codes, the message log the phone syncs from, file metadata and
 * per-agent display settings. NanoClaw's central and session DBs stay the
 * source of truth for routing; this log is a delivery mirror so a phone that
 * was offline can catch up (`rev` is a monotonically increasing change
 * counter: every insert or update stamps a new rev, clients sync with
 * `after=<last rev seen>`).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

export type MessageDirection = 'in' | 'out';
export type MessageKind = 'text' | 'card';

export interface CardOption {
  label: string;
  selectedLabel: string;
  value: string;
  style?: 'primary' | 'danger' | 'default';
}

export interface CardData {
  questionId: string;
  title: string;
  question: string;
  options: CardOption[];
  /** Set once answered (by a tap here or a terminal edit from the host). */
  resolution?: string;
  answeredBy?: string;
  answeredAt?: string;
}

export interface FileRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface AppMessage {
  id: string;
  rev: number;
  conversationId: string;
  userHandle: string;
  direction: MessageDirection;
  kind: MessageKind;
  text: string;
  card: CardData | null;
  files: FileRef[];
  senderName: string | null;
  failure: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  id: string;
  userHandle: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  apnsToken: string | null;
  /** 'development' (sandbox, direct installs) or 'production' (TestFlight/App Store). */
  apnsEnv: 'development' | 'production' | null;
}

export interface AgentMeta {
  folder: string;
  color: string | null;
  avatarFile: string | null;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  rev: number;
  conversation_id: string;
  user_handle: string;
  direction: MessageDirection;
  kind: MessageKind;
  text: string;
  card_json: string | null;
  files_json: string;
  sender_name: string | null;
  failure: number;
  created_at: string;
  updated_at: string;
}

interface DeviceRow {
  id: string;
  user_handle: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  apns_token: string | null;
  apns_env: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  apns_token TEXT
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL,
  display_name TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  card_json TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  sender_name TEXT,
  failure INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user_rev ON messages (user_handle, rev);
CREATE INDEX IF NOT EXISTS messages_conv_rev ON messages (conversation_id, rev);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_meta (
  folder TEXT PRIMARY KEY,
  color TEXT,
  avatar_file TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

/** SHA-256 hex. Tokens and pairing codes are stored only as hashes. */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

/** Pairing code alphabet without look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePairCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class AppStore {
  readonly db: Database.Database;
  readonly filesDir: string;
  readonly avatarsDir: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.filesDir = path.join(dir, 'files');
    this.avatarsDir = path.join(dir, 'avatars');
    fs.mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.avatarsDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dir, 'app.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    const cols = this.db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'apns_env')) this.db.exec('ALTER TABLE devices ADD COLUMN apns_env TEXT');
  }

  close(): void {
    this.db.close();
  }

  private nextRev(): number {
    const row = this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES ('rev', 1)
           ON CONFLICT (name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .get() as { value: number };
    return row.value;
  }

  // ── Pairing ──

  createPairCode(
    userHandle: string,
    displayName: string | null,
    now = Date.now(),
  ): { code: string; expiresAt: string } {
    const code = generatePairCode();
    const expiresAt = new Date(now + PAIR_CODE_TTL_MS).toISOString();
    this.db
      .prepare('INSERT INTO pair_codes (code_hash, user_handle, display_name, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashSecret(code), userHandle, displayName, expiresAt);
    return { code, expiresAt };
  }

  /**
   * Exchange a one-time code for a new device + bearer token. Returns null
   * when the code is unknown, used or expired. The token is returned once and
   * only its hash is kept.
   */
  redeemPairCode(
    code: string,
    deviceName: string,
    now = Date.now(),
  ): { device: Device; token: string; displayName: string | null } | null {
    const codeHash = hashSecret(normalizePairCode(code));
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT user_handle, display_name, expires_at, used_at FROM pair_codes WHERE code_hash = ?')
        .get(codeHash) as
        | { user_handle: string; display_name: string | null; expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.used_at || Date.parse(row.expires_at) < now) return null;
      const nowIso = new Date(now).toISOString();
      this.db.prepare('UPDATE pair_codes SET used_at = ? WHERE code_hash = ?').run(nowIso, codeHash);
      const token = crypto.randomBytes(32).toString('base64url');
      const device: Device = {
        id: newId('dev'),
        userHandle: row.user_handle,
        name: deviceName.slice(0, 80) || 'device',
        createdAt: nowIso,
        lastSeenAt: nowIso,
        revokedAt: null,
        apnsToken: null,
        apnsEnv: null,
      };
      this.db
        .prepare(
          `INSERT INTO devices (id, user_handle, name, token_hash, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(device.id, device.userHandle, device.name, hashSecret(token), device.createdAt, device.lastSeenAt);
      return { device, token, displayName: row.display_name };
    });
    return tx();
  }

  /** Drop expired and used codes older than a day. */
  pruneCodes(now = Date.now()): void {
    const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare('DELETE FROM pair_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)')
      .run(new Date(now).toISOString(), cutoff);
  }

  // ── Devices ──

  authenticate(token: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hashSecret(token)) as
      | DeviceRow
      | undefined;
    if (!row || row.revoked_at) return null;
    return toDevice(row);
  }

  touchDevice(id: string, now = new Date().toISOString()): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  setApnsToken(id: string, apnsToken: string | null, env: 'development' | 'production' | null = null): void {
    this.db.prepare('UPDATE devices SET apns_token = ?, apns_env = ? WHERE id = ?').run(apnsToken, env, id);
  }

  /** Forget a token APNs rejected (app removed, token rotated). */
  clearApnsToken(apnsToken: string): void {
    this.db.prepare('UPDATE devices SET apns_token = NULL, apns_env = NULL WHERE apns_token = ?').run(apnsToken);
  }

  /** Active devices of a user that registered for push. */
  pushTargets(userHandle: string): Device[] {
    const rows = this.db
      .prepare('SELECT * FROM devices WHERE user_handle = ? AND revoked_at IS NULL AND apns_token IS NOT NULL')
      .all(userHandle) as DeviceRow[];
    return rows.map(toDevice);
  }

  /** When the person last wrote in this conversation (null = never). */
  lastInboundAt(conversationId: string): string | null {
    const row = this.db
      .prepare(`SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ? AND direction = 'in'`)
      .get(conversationId) as { at: string | null };
    return row.at;
  }

  countOpenCards(userHandle: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE user_handle = ? AND kind = 'card'
           AND json_extract(card_json, '$.resolution') IS NULL`,
      )
      .get(userHandle) as { n: number };
    return row.n;
  }

  listDevices(userHandle?: string): Device[] {
    const rows = (
      userHandle
        ? this.db.prepare('SELECT * FROM devices WHERE user_handle = ? ORDER BY created_at').all(userHandle)
        : this.db.prepare('SELECT * FROM devices ORDER BY user_handle, created_at').all()
    ) as DeviceRow[];
    return rows.map(toDevice);
  }

  revokeDevice(id: string, now = new Date().toISOString()): boolean {
    const res = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    return res.changes > 0;
  }

  // ── Messages ──

  insertMessage(msg: Omit<AppMessage, 'rev' | 'updatedAt' | 'createdAt'> & { createdAt?: string }): AppMessage {
    const createdAt = msg.createdAt ?? new Date().toISOString();
    const rev = this.nextRev();
    this.db
      .prepare(
        `INSERT INTO messages (id, rev, conversation_id, user_handle, direction, kind, text, card_json,
                               files_json, sender_name, failure, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        rev,
        msg.conversationId,
        msg.userHandle,
        msg.direction,
        msg.kind,
        msg.text,
        msg.card ? JSON.stringify(msg.card) : null,
        JSON.stringify(msg.files),
        msg.senderName,
        msg.failure ? 1 : 0,
        createdAt,
        createdAt,
      );
    return this.getMessage(msg.id)!;
  }

  getMessage(id: string): AppMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  /** Apply a change and bump rev so syncing clients pick it up. */
  updateMessage(id: string, patch: { text?: string; card?: CardData | null }): AppMessage | null {
    const existing = this.getMessage(id);
    if (!existing) return null;
    const rev = this.nextRev();
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE messages SET rev = ?, text = ?, card_json = ?, updated_at = ? WHERE id = ?')
      .run(
        rev,
        patch.text ?? existing.text,
        patch.card === undefined
          ? existing.card
            ? JSON.stringify(existing.card)
            : null
          : patch.card
            ? JSON.stringify(patch.card)
            : null,
        now,
        id,
      );
    return this.getMessage(id);
  }

  findCardByQuestion(questionId: string): AppMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE kind = 'card' AND json_extract(card_json, '$.questionId') = ?`)
      .all(questionId) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Everything for a user changed after `afterRev`, oldest first. */
  syncForUser(userHandle: string, afterRev: number, limit: number): AppMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE user_handle = ? AND rev > ? ORDER BY rev ASC LIMIT ?')
      .all(userHandle, afterRev, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  /** One conversation, newest first, paged by created_at/id. */
  conversationPage(conversationId: string, before: string | null, limit: number): AppMessage[] {
    const rows = (
      before
        ? this.db
            .prepare(
              'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, rev DESC LIMIT ?',
            )
            .all(conversationId, before, limit)
        : this.db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rev DESC LIMIT ?')
            .all(conversationId, limit)
    ) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Merged feed of agent messages across a user's conversations, newest first. */
  feedPage(userHandle: string, before: string | null, limit: number): AppMessage[] {
    const rows = (
      before
        ? this.db
            .prepare(
              `SELECT * FROM messages WHERE user_handle = ? AND direction = 'out' AND created_at < ?
                 ORDER BY created_at DESC, rev DESC LIMIT ?`,
            )
            .all(userHandle, before, limit)
        : this.db
            .prepare(
              `SELECT * FROM messages WHERE user_handle = ? AND direction = 'out'
                 ORDER BY created_at DESC, rev DESC LIMIT ?`,
            )
            .all(userHandle, limit)
    ) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Unanswered cards for a user: the feed's pinned "needs you" items. */
  openCards(userHandle: string): AppMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE user_handle = ? AND kind = 'card'
           AND json_extract(card_json, '$.resolution') IS NULL
         ORDER BY created_at DESC`,
      )
      .all(userHandle) as MessageRow[];
    return rows.map(toMessage);
  }

  lastMessage(conversationId: string): AppMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rev DESC LIMIT 1')
      .get(conversationId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  latestRev(): number {
    const row = this.db.prepare(`SELECT value FROM counters WHERE name = 'rev'`).get() as { value: number } | undefined;
    return row?.value ?? 0;
  }

  // ── Files ──

  /** Store bytes under a random id; the filename is metadata only, never a path. */
  saveFile(messageId: string, userHandle: string, filename: string, mimeType: string, data: Buffer): FileRef {
    const id = newId('file');
    fs.writeFileSync(path.join(this.filesDir, id), data, { mode: 0o600, flag: 'wx' });
    const ref: FileRef = { id, filename, mimeType, size: data.length };
    this.db
      .prepare(
        `INSERT INTO files (id, message_id, user_handle, filename, mime_type, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, messageId, userHandle, filename, mimeType, data.length, new Date().toISOString());
    return ref;
  }

  getFile(id: string): (FileRef & { userHandle: string; path: string }) | null {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      | { id: string; user_handle: string; filename: string; mime_type: string; size: number }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      userHandle: row.user_handle,
      path: path.join(this.filesDir, row.id),
    };
  }

  // ── Agent display settings ──

  getAgentMeta(folder: string): AgentMeta | null {
    const row = this.db.prepare('SELECT * FROM agent_meta WHERE folder = ?').get(folder) as
      | { folder: string; color: string | null; avatar_file: string | null; updated_at: string }
      | undefined;
    return row
      ? { folder: row.folder, color: row.color, avatarFile: row.avatar_file, updatedAt: row.updated_at }
      : null;
  }

  setAgentMeta(folder: string, patch: { color?: string | null; avatarFile?: string | null }): AgentMeta {
    const existing = this.getAgentMeta(folder);
    const next: AgentMeta = {
      folder,
      color: patch.color === undefined ? (existing?.color ?? null) : patch.color,
      avatarFile: patch.avatarFile === undefined ? (existing?.avatarFile ?? null) : patch.avatarFile,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_meta (folder, color, avatar_file, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (folder) DO UPDATE SET color = excluded.color, avatar_file = excluded.avatar_file,
                                              updated_at = excluded.updated_at`,
      )
      .run(next.folder, next.color, next.avatarFile, next.updatedAt);
    return next;
  }
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userHandle: row.user_handle,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    apnsToken: row.apns_token,
    apnsEnv: row.apns_env === 'development' || row.apns_env === 'production' ? row.apns_env : null,
  };
}

function toMessage(row: MessageRow): AppMessage {
  return {
    id: row.id,
    rev: row.rev,
    conversationId: row.conversation_id,
    userHandle: row.user_handle,
    direction: row.direction,
    kind: row.kind,
    text: row.text,
    card: row.card_json ? (JSON.parse(row.card_json) as CardData) : null,
    files: JSON.parse(row.files_json) as FileRef[],
    senderName: row.sender_name,
    failure: row.failure === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
