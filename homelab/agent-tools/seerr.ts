#!/usr/bin/env bun
/**
 * Seerr: film and TV requests for the family. The OneCLI proxy adds the Seerr API key, so this
 * tool holds no secret. Requests are filed for a named family member, and Seerr's own rules decide
 * approval for anything a person files in Seerr itself.
 *
 *   bun seerr.ts search <title...> [--type movie|tv]     matches with tmdb id, year and status
 *   bun seerr.ts request <movie|tv> <tmdbId> --for <first name> [--seasons all|1,2]
 *   bun seerr.ts pending                                 requests waiting for a parent
 *   bun seerr.ts recent [--take 10]                      latest requests and where they are
 *   bun seerr.ts approve <requestId>                     only when a parent asks
 *   bun seerr.ts decline <requestId>                     only when a parent asks
 *
 * Base URL: $SEERR_URL, else the first line of seerr.url next to this file. Output is JSON.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const MEDIA_STATUS: Record<number, string> = {
  1: 'not requested',
  2: 'requested, waiting for approval',
  3: 'requested, downloading or queued',
  4: 'partly available',
  5: 'available',
  6: 'blocked',
  7: 'deleted',
};
export const REQUEST_STATUS: Record<number, string> = {
  1: 'waiting for approval',
  2: 'approved',
  3: 'declined',
  4: 'failed',
  5: 'completed',
};

const fail = (msg: string): never => {
  throw new Error(msg);
};

export function parseArgs(argv: string[]): { pos: string[]; opts: Record<string, string> } {
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, opts };
}

export function parseSeasons(s: string | undefined): number[] | 'all' {
  if (s === undefined || s === 'all') return 'all';
  const nums = s.split(',').map((x) => Number(x.trim()));
  if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) {
    fail(`bad --seasons "${s}" (all, or a list like 1,2)`);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

const year = (d?: string) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);
const short = (s?: string, n = 160) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function makeClient(base: string, fetchImpl: Fetch) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${base}/api/v1${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 300) };
    }
    if (!res.ok) fail(`Seerr ${method} ${path.split('?')[0]} -> ${res.status}: ${data?.message ?? data?.error ?? 'error'}`);
    return data;
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b ?? {}) };
}
type Client = ReturnType<typeof makeClient>;

async function title(c: Client, type: string, tmdbId: number): Promise<string> {
  try {
    const d = await c.get(`/${type}/${tmdbId}`);
    const y = year(d.releaseDate ?? d.firstAirDate);
    return `${d.title ?? d.name}${y ? ` (${y})` : ''}`;
  } catch {
    return `${type} ${tmdbId}`;
  }
}

async function findUser(c: Client, name: string) {
  const want = name.trim().toLowerCase();
  const res = await c.get('/user?take=50');
  const users = (res.results ?? []) as any[];
  const hit = users.filter(
    (u) =>
      [u.displayName, u.username, u.jellyfinUsername]
        .filter(Boolean)
        .some((n: string) => n.toLowerCase() === want || n.toLowerCase().split(/\s+/)[0] === want),
  );
  if (hit.length !== 1) {
    fail(`no single Seerr user named "${name}" (known: ${users.map((u) => u.displayName).join(', ')})`);
  }
  return hit[0];
}

async function describeRequests(c: Client, results: any[]) {
  return Promise.all(
    results.map(async (r) => ({
      requestId: r.id,
      title: await title(c, r.type, r.media?.tmdbId),
      type: r.type,
      seasons: r.type === 'tv' ? (r.seasons ?? []).map((s: any) => s.seasonNumber) : undefined,
      requestedBy: r.requestedBy?.displayName,
      requested: r.createdAt?.slice(0, 10),
      request: REQUEST_STATUS[r.status] ?? r.status,
      media: MEDIA_STATUS[r.media?.status] ?? r.media?.status,
    })),
  );
}

export function defaultBase(): string {
  if (process.env.SEERR_URL) return process.env.SEERR_URL;
  try {
    const f = new URL('./seerr.url', import.meta.url);
    const line = require('node:fs').readFileSync(f, 'utf8').split('\n')[0].trim();
    if (line) return line;
  } catch {}
  return fail('no Seerr URL: set SEERR_URL or write it to seerr.url next to seerr.ts');
}

export async function main(argv: string[], fetchImpl: Fetch = fetch, base = defaultBase()) {
  const { pos, opts } = parseArgs(argv);
  const c = makeClient(base.replace(/\/+$/, ''), fetchImpl);
  const [cmd, ...rest] = pos;

  switch (cmd) {
    case 'search': {
      const q = rest.join(' ').trim();
      if (!q) fail('usage: search <title> [--type movie|tv]');
      const type = opts.type;
      if (type && type !== 'movie' && type !== 'tv') fail('--type must be movie or tv');
      const res = await c.get(`/search?query=${encodeURIComponent(q)}&page=1&language=en`);
      const items = ((res.results ?? []) as any[])
        .filter((r) => (r.mediaType === 'movie' || r.mediaType === 'tv') && (!type || r.mediaType === type))
        .slice(0, 6)
        .map((r) => ({
          tmdbId: r.id,
          type: r.mediaType,
          title: r.title ?? r.name,
          year: year(r.releaseDate ?? r.firstAirDate),
          status: MEDIA_STATUS[r.mediaInfo?.status ?? 1],
          overview: short(r.overview),
        }));
      return { query: q, results: items };
    }
    case 'request': {
      const [type, idRaw] = rest;
      if (type !== 'movie' && type !== 'tv') fail('usage: request <movie|tv> <tmdbId> --for <name> [--seasons all|1,2]');
      const tmdbId = Number(idRaw);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) fail(`bad tmdb id "${idRaw}"`);
      if (!opts.for) fail('--for <first name> is required (who is asking)');
      if (type === 'movie' && opts.seasons) fail('--seasons is only for tv');
      const user = await findUser(c, opts.for);
      const details = await c.get(`/${type}/${tmdbId}`);
      const status = details.mediaInfo?.status ?? 1;
      if (status === 5) return { done: false, reason: 'already available', title: await title(c, type, tmdbId) };
      const body: Record<string, unknown> = { mediaType: type, mediaId: tmdbId, userId: user.id };
      if (type === 'tv') body.seasons = parseSeasons(opts.seasons);
      const r = await c.post('/request', body);
      return {
        done: true,
        requestId: r.id,
        title: await title(c, type, tmdbId),
        for: user.displayName,
        request: REQUEST_STATUS[r.status] ?? r.status,
      };
    }
    case 'pending': {
      const res = await c.get('/request?take=20&filter=pending&sort=added');
      return { pending: await describeRequests(c, res.results ?? []) };
    }
    case 'recent': {
      const take = Math.min(Math.max(Number(opts.take ?? 10) || 10, 1), 30);
      const res = await c.get(`/request?take=${take}&filter=all&sort=added`);
      return { recent: await describeRequests(c, res.results ?? []) };
    }
    case 'approve':
    case 'decline': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) fail(`usage: ${cmd} <requestId>`);
      const r = await c.post(`/request/${id}/${cmd}`);
      const [d] = await describeRequests(c, [r]);
      return { done: true, ...d };
    }
    default:
      fail('usage: search | request | pending | recent | approve | decline (see the header of seerr.ts)');
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((e) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    });
}
