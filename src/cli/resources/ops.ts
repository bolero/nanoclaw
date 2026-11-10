/**
 * `ncl ops redeploy-stack`: an approval-gated Dockhand redeploy.
 *
 * Dockhand's free plan has no scoped tokens, so agents never hold one. They
 * request the named action here; an agent caller is held for the owner's
 * Approve/Deny card (access 'approval'), and only an approved replay reaches
 * the handler, which runs on the host with the token from a private env file.
 * Only the git-stack deploy endpoint is reachable, for a numeric stack id.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../log.js';
import { registerResource } from '../crud.js';

const ENV_FILE = process.env.DOCKHAND_PROXY_ENV ?? path.join(os.homedir(), '.config', 'nanoclaw', 'dockhand-proxy.env');
const DEPLOY_TIMEOUT_MS = 5 * 60_000;

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export async function redeployStack(id: number): Promise<string> {
  const env = readEnvFile();
  const token = env.DOCKHAND_TOKEN;
  if (!token) throw new Error('Dockhand token is not configured on the host.');
  const base = (env.DOCKHAND_URL ?? 'https://docker.bhlr.dev').replace(/\/$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEPLOY_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/git/stacks/${id}/deploy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      signal: ctl.signal,
    });
    const body = (await res.text()).slice(-1500);
    log.info('ops redeploy-stack', { id, status: res.status });
    if (!res.ok) throw new Error(`Dockhand answered ${res.status}: ${body.slice(0, 300)}`);
    return `Deploy of git stack ${id} finished (HTTP ${res.status}). Last output:\n${body}`;
  } finally {
    clearTimeout(timer);
  }
}

registerResource({
  name: 'op',
  plural: 'ops',
  table: 'ops',
  description: 'Approval-gated homelab operations that run on the host.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    'redeploy-stack': {
      access: 'approval',
      description:
        'Redeploy one Dockhand git stack by numeric id (find ids with GET /api/git/stacks on the read-only Dockhand proxy). Requires the owner to approve each request.',
      args: [{ name: 'stack', type: 'number', required: true, description: 'Numeric Dockhand git stack id.' }],
      examples: ['ncl ops redeploy-stack --stack 24'],
      handler: async (args): Promise<string> => {
        const raw = String(args.stack).trim();
        if (!/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error('--stack must be a positive integer (digits only)');
        const id = Number(raw);
        return redeployStack(id);
      },
      formatHuman: (data) => String(data),
    },
  },
});
