/**
 * App channel addressing.
 *
 *   user id         app:<handle>
 *   home convo      app:<handle>               (the user's DM; approvals and cold DMs land here)
 *   agent convo     app:<handle>:<agentFolder> (one chat per agent the user can talk to)
 *
 * The conversation id the phone sees is the messaging group's platform_id.
 */
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function homeConversationId(handle: string): string {
  return `app:${handle}`;
}

export function agentConversationId(handle: string, folder: string): string {
  return `app:${handle}:${folder}`;
}

/** Parse a conversation id; null when it isn't one of ours. */
export function parseConversationId(id: string): { handle: string; folder: string | null } | null {
  const parts = id.split(':');
  if (parts[0] !== 'app' || parts.length < 2 || parts.length > 3) return null;
  const handle = parts[1]!;
  if (!HANDLE_RE.test(handle)) return null;
  if (parts.length === 2) return { handle, folder: null };
  const folder = parts[2]!;
  if (!FOLDER_RE.test(folder)) return null;
  return { handle, folder };
}

export function conversationOwner(id: string): string | null {
  return parseConversationId(id)?.handle ?? null;
}

/** Accepts `abhi` or `app:abhi`; returns the bare handle or null. */
export function parseHandle(raw: string): string | null {
  const handle = raw.startsWith('app:') ? raw.slice(4) : raw;
  return HANDLE_RE.test(handle) ? handle : null;
}
