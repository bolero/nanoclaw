/**
 * Host-side Dockhand access for approval-gated ops. The token lives in a private
 * env file on the host and never reaches an agent container.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const envFile = (): string =>
  process.env.DOCKHAND_PROXY_ENV ?? path.join(os.homedir(), '.config', 'nanoclaw', 'dockhand-proxy.env');
const LOOKUP_TIMEOUT_MS = 15_000;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envFile(), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function dockhand(): { base: string; token: string } {
  const env = readEnvFile();
  const token = env.DOCKHAND_TOKEN;
  if (!token) throw new Error('Dockhand token is not configured on the host.');
  return { base: (env.DOCKHAND_URL ?? 'https://docker.bhlr.dev').replace(/\/$/, ''), token };
}

export async function getJson(base: string, token: string, p: string): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(base + p, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal: ctl.signal,
    });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}
