/**
 * `ncl ops redeploy-stack`: an approval-gated Dockhand redeploy.
 *
 * Dockhand's free plan has no scoped tokens, so agents never hold one. They
 * request the named action here; an agent caller is held for the owner's
 * Approve/Deny card (access 'approval'), and only an approved replay reaches
 * the handler, which runs on the host with the token from a private env file.
 * Only the git-stack deploy endpoint is reachable, for a numeric stack id.
 *
 * Before the hold, `preApproval` resolves the id against Dockhand: an unknown
 * id is refused with no card, and the card names the stack, host and action.
 */
import { log } from '../../log.js';
import { registerResource } from '../crud.js';
import { dockhand, getJson, SAFE_NAME } from './dockhand-api.js';
import {
  describeUpdate,
  formatVersions,
  imageVersions,
  resolveUpdate,
  runUpdate,
  type VersionRow,
} from './dockhand-updates.js';

const DEPLOY_TIMEOUT_MS = 5 * 60_000;

export function parseStackId(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error('--stack must be a positive integer (digits only)');
  return Number(raw);
}

export interface StackInfo {
  id: number;
  name: string;
  host: string;
}

/** Resolve a git stack id to its name and host. Throws for unknown ids or odd data. */
export async function lookupStack(id: number): Promise<StackInfo> {
  const { base, token } = dockhand();
  const stack = await getJson(base, token, `/api/git/stacks/${id}`);
  if (stack.status === 404) throw new Error(`No Dockhand git stack with id ${id}. Refused; no approval was requested.`);
  const s = stack.body as { id?: unknown; stackName?: unknown; environmentId?: unknown } | null;
  if (!s || s.id !== id || typeof s.stackName !== 'string')
    throw new Error(`Could not verify git stack ${id} (Dockhand answered ${stack.status}).`);
  if (!SAFE_NAME.test(s.stackName)) throw new Error(`Git stack ${id} has an unexpected name; refusing.`);
  let host = 'unknown host';
  if (Number.isInteger(s.environmentId)) {
    const env = await getJson(base, token, `/api/environments/${s.environmentId}`);
    const name = (env.body as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && SAFE_NAME.test(name)) host = name;
  }
  return { id, name: s.stackName, host };
}

export function describeRedeploy(info: StackInfo): string {
  return [
    `Stack: ${info.name} (git stack #${info.id})`,
    `Host: ${info.host}`,
    'Action: redeploy from git (pull, then docker compose up)',
  ].join('\n');
}

export async function redeployStack(id: number): Promise<string> {
  const { base, token } = dockhand();
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
      preApproval: async (raw) => describeRedeploy(await lookupStack(parseStackId(raw.stack))),
      handler: async (args): Promise<string> => {
        const id = parseStackId(args.stack);
        await lookupStack(id); // re-check after approval: the stack may have been removed meanwhile
        return redeployStack(id);
      },
      formatHuman: (data) => String(data),
    },
    'update-containers': {
      access: 'approval',
      description:
        "Pull the newer image and recreate containers that Dockhand's update check flagged (GET /api/containers/pending-updates?env=<id> on the read-only proxy). Up to 10 names per request, one host per request. Databases, caches and network/VPN containers are refused unless --include-risky true. No automatic rollback. Requires the owner to approve each request.",
      args: [
        {
          name: 'env',
          type: 'number',
          required: true,
          description: 'Dockhand environment id (see GET /api/environments).',
        },
        { name: 'containers', type: 'string', required: true, description: 'Comma-separated container names.' },
        {
          name: 'include-risky',
          type: 'boolean',
          description: 'Allow database/cache/network containers. Request these one at a time.',
        },
      ],
      examples: [
        'ncl ops update-containers --env 3 --containers homepage,code-server',
        'ncl ops update-containers --env 3 --containers outline-redis --include-risky true',
      ],
      preApproval: async (raw) => describeUpdate(await resolveUpdate(raw)),
      handler: async (args): Promise<string> => runUpdate(await resolveUpdate(args)), // re-checked after approval
      formatHuman: (data) => String(data),
    },
    'image-versions': {
      access: 'open',
      description:
        'Read-only: current and available version for containers with a pending update (or the named ones), read from the image registry without pulling. Shows ? when an image carries no version label.',
      args: [
        { name: 'env', type: 'number', required: true, description: 'Dockhand environment id.' },
        {
          name: 'containers',
          type: 'string',
          description: 'Optional comma-separated names; default is every container with a pending update.',
        },
        { name: 'arch', type: 'string', description: 'amd64 (default), arm64 or arm.' },
      ],
      examples: ['ncl ops image-versions --env 4'],
      handler: async (args): Promise<VersionRow[]> => imageVersions(args),
      formatHuman: (data) => formatVersions(data as VersionRow[]),
    },
  },
});
