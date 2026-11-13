/**
 * Container image updates through Dockhand, for `ncl ops update-containers`
 * (approval-gated) and `ncl ops image-versions` (read-only).
 *
 * update-containers only acts on containers Dockhand's own update check has
 * flagged (`/api/containers/pending-updates`), refuses digest-pinned images, and
 * refuses databases, caches and network/VPN containers unless --include-risky is
 * passed. Dockhand's batch-update pulls the image and recreates each container;
 * it has no rollback, so the card says so.
 */
import { log } from '../../log.js';
import { dockhand, getJson, SAFE_NAME } from './dockhand-api.js';

const UPDATE_TIMEOUT_MS = 15 * 60_000;
const REGISTRY_TIMEOUT_MS = 15_000;
const MAX_CONTAINERS = 10;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/;

/** Stateful or connectivity-critical images: a bad pull here loses data or cuts off other services. */
export const RISKY =
  /(postgres|pgvector|postgis|timescale|mariadb|mysql|mongo|redis|valkey|keydb|influx|clickhouse|elasticsearch|opensearch|gluetun|wireguard|tailscale|cloudflared|newt|pangolin|traefik|caddy|nginx-proxy|dockhand|hawser)/i;

export function parseEnvId(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error('--env must be a positive integer (Dockhand environment id)');
  return Number(raw);
}

export function parseNames(value: unknown): string[] {
  const names = [
    ...new Set(
      String(value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) throw new Error('--containers needs at least one container name (comma-separated)');
  if (names.length > MAX_CONTAINERS) throw new Error(`--containers takes at most ${MAX_CONTAINERS} names per request`);
  for (const n of names)
    if (!SAFE_NAME.test(n)) throw new Error(`Container name "${n.slice(0, 40)}" has unexpected characters`);
  return names;
}

const truthy = (v: unknown): boolean => v === true || v === 'true';

interface DhContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
}

interface Pending {
  containerId?: string;
  containerName?: string;
  hasImageUpdate?: boolean;
  pinnedToDigest?: boolean;
  checkedAt?: string;
}

const cleanName = (n: unknown): string => String(n ?? '').replace(/^\//, '');

async function loadEnv(env: number): Promise<{ host: string; containers: DhContainer[]; pending: Pending[] }> {
  const { base, token } = dockhand();
  const envRes = await getJson(base, token, `/api/environments/${env}`);
  const hostName = (envRes.body as { name?: unknown } | null)?.name;
  if (envRes.status === 404 || typeof hostName !== 'string')
    throw new Error(`No Dockhand environment with id ${env}. Refused; no approval was requested.`);
  const host = SAFE_NAME.test(hostName) ? hostName : `environment ${env}`;
  const [list, pend] = await Promise.all([
    getJson(base, token, `/api/containers?env=${env}`),
    getJson(base, token, `/api/containers/pending-updates?env=${env}`),
  ]);
  if (!Array.isArray(list.body))
    throw new Error(`Could not list containers on ${host} (Dockhand answered ${list.status}).`);
  const containers = (list.body as Record<string, unknown>[]).map((c) => ({
    id: String(c.id ?? ''),
    name: cleanName(c.name ?? (Array.isArray(c.names) ? c.names[0] : '')),
    image: String(c.image ?? ''),
    labels: (c.labels && typeof c.labels === 'object' ? c.labels : {}) as Record<string, string>,
  }));
  const pending = ((pend.body as { pendingUpdates?: unknown } | null)?.pendingUpdates ?? []) as Pending[];
  if (!Array.isArray(pending)) throw new Error(`Unexpected pending-updates answer from Dockhand for ${host}.`);
  return { host, containers, pending };
}

function pendingFor(c: DhContainer, pending: Pending[]): Pending | undefined {
  return pending.find((p) => p.containerId === c.id || cleanName(p.containerName) === c.name);
}

export interface UpdateItem {
  id: string;
  name: string;
  image: string;
  checkedAt: string;
  risky: boolean;
}
export interface UpdatePlan {
  env: number;
  host: string;
  items: UpdateItem[];
}

/** Validate a request against Dockhand's current state. Throws (no card) on anything off. */
export async function resolveUpdate(raw: Record<string, unknown>): Promise<UpdatePlan> {
  const env = parseEnvId(raw.env);
  const names = parseNames(raw.containers);
  const includeRisky = truthy(raw['include-risky'] ?? raw.include_risky ?? raw.includeRisky);
  const { host, containers, pending } = await loadEnv(env);
  const items: UpdateItem[] = [];
  const problems: string[] = [];
  for (const name of names) {
    const c = containers.find((x) => x.name === name);
    if (!c) {
      problems.push(`${name}: no such container on ${host}`);
      continue;
    }
    if (!SAFE_IMAGE.test(c.image)) {
      problems.push(`${name}: unexpected image reference`);
      continue;
    }
    const p = pendingFor(c, pending);
    if (!p || p.hasImageUpdate !== true) {
      problems.push(`${name}: Dockhand has no pending image update for it`);
      continue;
    }
    if (p.pinnedToDigest || c.image.includes('@sha256:')) {
      problems.push(`${name}: image is pinned to a digest; change the pin instead`);
      continue;
    }
    if (c.labels['dockhand.update'] === 'false') {
      problems.push(`${name}: labelled dockhand.update=false`);
      continue;
    }
    const risky = RISKY.test(c.name) || RISKY.test(c.image);
    if (risky && !includeRisky) {
      problems.push(`${name}: database/cache/network container; request it on its own with --include-risky true`);
      continue;
    }
    items.push({ id: c.id, name: c.name, image: c.image, checkedAt: String(p.checkedAt ?? '?').slice(0, 25), risky });
  }
  if (problems.length) throw new Error(`Refused; no approval was requested.\n- ${problems.join('\n- ')}`);
  return { env, host, items };
}

export function describeUpdate(plan: UpdatePlan): string {
  const lines = [
    `Host: ${plan.host} (Dockhand env ${plan.env})`,
    'Action: pull newer image and recreate (no automatic rollback)',
  ];
  for (const i of plan.items) lines.push(`- ${i.name}: ${i.image}${i.risky ? ' [RISKY: stateful/network]' : ''}`);
  lines.push(`Update flagged by Dockhand check at ${plan.items[0]?.checkedAt ?? '?'}`);
  return lines.join('\n');
}

export async function runUpdate(plan: UpdatePlan): Promise<string> {
  const { base, token } = dockhand();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPDATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/containers/batch-update?env=${plan.env}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ containerIds: plan.items.map((i) => i.id) }),
      redirect: 'manual',
      signal: ctl.signal,
    });
    const text = await res.text();
    log.info('ops update-containers', { env: plan.env, containers: plan.items.map((i) => i.name), status: res.status });
    if (!res.ok) throw new Error(`Dockhand answered ${res.status}: ${text.slice(0, 300)}`);
    return summarizeBatch(plan, text);
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeBatch(plan: UpdatePlan, text: string): string {
  let body: { results?: unknown; summary?: { total?: number; success?: number; failed?: number } };
  try {
    body = JSON.parse(text);
  } catch {
    return `Update on ${plan.host} finished, but Dockhand's answer was not JSON:\n${text.slice(-800)}`;
  }
  const byId = new Map(plan.items.map((i) => [i.id, i.name]));
  const lines = [`Update on ${plan.host}:`];
  for (const r of Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : []) {
    const id = String(r.containerId ?? r.id ?? '');
    const name = byId.get(id) ?? cleanName(r.containerName ?? r.name ?? id).slice(0, 64);
    const ok = r.success === true;
    const msg = String(r.error ?? r.message ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 200);
    lines.push(`- ${name}: ${ok ? 'updated' : 'FAILED'}${msg ? ` (${msg})` : ''}`);
  }
  const s = body.summary;
  if (s) lines.push(`Total ${s.total ?? '?'}, ok ${s.success ?? '?'}, failed ${s.failed ?? '?'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Versions: read the image config from the registry, never pull.
// ---------------------------------------------------------------------------

export interface ImageRef {
  registry: string;
  repo: string;
  tag: string;
}

export function parseImageRef(image: string): ImageRef | null {
  if (!SAFE_IMAGE.test(image) || image.includes('@')) return null;
  let rest = image;
  let registry = 'registry-1.docker.io';
  const first = rest.split('/')[0];
  if (rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first === 'docker.io' ? 'registry-1.docker.io' : first;
    rest = rest.slice(first.length + 1);
  }
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  let tag = 'latest';
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (registry === 'registry-1.docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  return { registry, repo: rest.toLowerCase(), tag };
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

async function timedFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REGISTRY_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function registryGet(ref: ImageRef, p: string, accept: string, auth: { token?: string }): Promise<Response> {
  const url = `https://${ref.registry}/v2/${ref.repo}/${p}`;
  const headers: Record<string, string> = { accept };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  let res = await timedFetch(url, headers);
  if (res.status === 401 && !auth.token) {
    const m = /Bearer\s+(.*)/i.exec(res.headers.get('www-authenticate') ?? '');
    if (!m) return res;
    const params = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (!params.realm?.startsWith('https://')) return res;
    const q = new URLSearchParams();
    if (params.service) q.set('service', params.service);
    q.set('scope', params.scope ?? `repository:${ref.repo}:pull`);
    const tr = await timedFetch(`${params.realm}?${q}`, { accept: 'application/json' });
    if (!tr.ok) return res;
    const tj = (await tr.json()) as { token?: string; access_token?: string };
    auth.token = tj.token ?? tj.access_token;
    if (!auth.token) return res;
    res = await timedFetch(url, { ...headers, authorization: `Bearer ${auth.token}` });
  }
  return res;
}

const VERSION_ENV =
  /^(PG_VERSION|REDIS_VERSION|MARIADB_VERSION|MYSQL_VERSION|MONGO_VERSION|NGINX_VERSION|VERSION)=(.+)$/;
// Branch/channel names some images put in the version label: not a version.
const NOT_A_VERSION = /^(latest|main|master|stable|dev|develop|nightly|edge|release)$/i;

export function versionFromConfig(cfg: {
  Labels?: Record<string, string> | null;
  Env?: string[] | null;
}): string | null {
  const label = cfg.Labels?.['org.opencontainers.image.version'];
  const candidates = [label, ...(cfg.Env ?? []).map((e) => VERSION_ENV.exec(e)?.[2])];
  for (const v of candidates) {
    const t = v?.trim().split(/\s+/)[0];
    if (t && SAFE_VERSION.test(t) && !NOT_A_VERSION.test(t)) return t;
  }
  return null;
}

/** Version of the image the tag currently points to in its registry, or a short reason. */
export async function remoteVersion(image: string, arch = 'amd64'): Promise<{ version: string | null; note?: string }> {
  const ref = parseImageRef(image);
  if (!ref) return { version: null, note: 'unparseable or digest-pinned' };
  const auth: { token?: string } = {};
  let res = await registryGet(ref, `manifests/${encodeURIComponent(ref.tag)}`, MANIFEST_ACCEPT, auth);
  if (!res.ok) return { version: null, note: `registry ${res.status}` };
  let man = (await res.json()) as {
    manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[];
    config?: { digest?: string };
  };
  if (Array.isArray(man.manifests)) {
    const pick =
      man.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === arch) ??
      man.manifests.find((m) => m.platform?.os === 'linux');
    if (!pick || !/^sha256:[0-9a-f]{64}$/.test(pick.digest)) return { version: null, note: 'no linux manifest' };
    res = await registryGet(ref, `manifests/${pick.digest}`, MANIFEST_ACCEPT, auth);
    if (!res.ok) return { version: null, note: `registry ${res.status}` };
    man = (await res.json()) as typeof man;
  }
  const cd = man.config?.digest;
  if (!cd || !/^sha256:[0-9a-f]{64}$/.test(cd)) return { version: null, note: 'no config' };
  res = await registryGet(ref, `blobs/${cd}`, 'application/json', auth);
  if (!res.ok) return { version: null, note: `registry ${res.status}` };
  const cfg = ((await res.json()) as { config?: { Labels?: Record<string, string>; Env?: string[] } }).config ?? {};
  const v = versionFromConfig(cfg);
  return v ? { version: v } : { version: null, note: 'image has no version label' };
}

/** Version from the running container's config. Only the version value leaves this function, never the env. */
async function currentFromInspect(env: number, id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) return null;
  const { base, token } = dockhand();
  const r = await getJson(base, token, `/api/containers/${id}?env=${env}`);
  const b = r.body as {
    Config?: { Env?: string[]; Labels?: Record<string, string> };
    config?: { Env?: string[]; Labels?: Record<string, string> };
  } | null;
  const cfg = b?.Config ?? b?.config;
  return cfg ? versionFromConfig({ Labels: cfg.Labels, Env: Array.isArray(cfg.Env) ? cfg.Env : [] }) : null;
}

export interface VersionRow {
  name: string;
  image: string;
  current: string;
  available: string;
  risky: boolean;
}

export async function imageVersions(raw: Record<string, unknown>): Promise<VersionRow[]> {
  const env = parseEnvId(raw.env);
  const only = raw.containers ? new Set(parseNames(raw.containers)) : null;
  const arch = String(raw.arch ?? 'amd64');
  if (!/^(amd64|arm64|arm)$/.test(arch)) throw new Error('--arch must be amd64, arm64 or arm');
  const { containers, pending } = await loadEnv(env);
  const targets = containers
    .filter((c) => (only ? only.has(c.name) : pendingFor(c, pending)?.hasImageUpdate === true))
    .slice(0, 40);
  const rows: VersionRow[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      let cur = versionFromConfig({ Labels: c.labels });
      if (!cur) cur = await currentFromInspect(env, c.id).catch(() => null);
      cur ??= '?';
      let available: string;
      try {
        const r = await remoteVersion(c.image, arch);
        available = r.version ?? `? (${r.note})`;
      } catch (err) {
        available = `? (${err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'lookup failed'})`;
      }
      rows.push({
        name: c.name,
        image: SAFE_IMAGE.test(c.image) ? c.image : '(odd image ref)',
        current: cur,
        available,
        risky: RISKY.test(c.name) || RISKY.test(c.image),
      });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatVersions(rows: VersionRow[]): string {
  if (rows.length === 0) return 'No containers with a pending update.';
  return rows
    .map((r) => `${r.name}  ${r.image}  ${r.current} -> ${r.available}${r.risky ? '  [risky]' : ''}`)
    .join('\n');
}
