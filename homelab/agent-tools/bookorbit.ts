#!/usr/bin/env bun
/**
 * BookOrbit: ebook and audiobook requests for the family. The OneCLI proxy adds the API key (owner's
 * account, scoped to requesting, auto-approve and managing requests), so this tool holds no secret.
 * A request is filed in the named person's name and lands in that person's own library; BookOrbit's
 * own rules decide whether it is approved straight away (parents) or waits for a parent (kids).
 *
 *   bun bookorbit.ts search <title...> [--author <name>] [--kind audiobook|ebook]
 *   bun bookorbit.ts request <provider> <providerId> --for <first name> --kind audiobook|ebook|both
 *   bun bookorbit.ts pending                     requests waiting for a parent
 *   bun bookorbit.ts recent [--take 10]          latest requests and where they are
 *   bun bookorbit.ts approve <requestId>         only when a parent asks
 *   bun bookorbit.ts decline <requestId>         only when a parent asks
 *
 * Config: bookorbit.json next to this file: {"url": "...", "people": {"<first name>": {"userId": N,
 * "libraryId": N}}}. $BOOKORBIT_URL overrides the url. Output is JSON.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Kind = 'audiobook' | 'ebook';
export type Person = { userId: number; libraryId: number };
export type Config = { url: string; people: Record<string, Person> };

export const STATUS: Record<string, string> = {
  pending: 'waiting for a parent',
  approved: 'approved, looking for a download',
  searching: 'looking for a download',
  grabbed: 'download found',
  downloading: 'downloading',
  importing: 'adding to the library',
  needs_review: 'downloaded, needs a check in BookOrbit',
  available: 'in the library',
  failed: 'failed',
  rejected: 'declined',
  cancelled: 'cancelled',
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

const norm = (s?: string) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const short = (s?: string, n = 160) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const intOrNull = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
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
    if (!res.ok) {
      const msg = Array.isArray(data?.message) ? data.message.join('; ') : (data?.message ?? data?.error ?? 'error');
      fail(`BookOrbit ${method} ${path.split('?')[0]} -> ${res.status}: ${msg}`);
    }
    return data;
  };
  /** The search answers as a server-sent event stream; read it to the end (or the time limit). */
  const stream = async (path: string, timeoutMs: number): Promise<any[]> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const out: any[] = [];
    try {
      const res = await fetchImpl(`${base}/api/v1${path}`, { headers: { Accept: 'text/event-stream' }, signal: ctl.signal });
      if (!res.ok) fail(`BookOrbit GET ${path.split('?')[0]} -> ${res.status}`);
      const text = await readAll(res, ctl.signal);
      for (const event of text.split('\n\n')) {
        const lines = event.split('\n');
        const name = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
        const data = lines.find((l) => l.startsWith('data:'));
        if (!data || (name && name !== 'message')) continue;
        try {
          const c = JSON.parse(data.slice(5).trim());
          if (c?.provider && c?.providerId) out.push(c);
        } catch {}
      }
    } finally {
      clearTimeout(timer);
    }
    return out;
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b ?? {}),
    stream,
  };
}
type Client = ReturnType<typeof makeClient>;

/** Everything the stream sent before it closed or the time ran out. */
async function readAll(res: Response, signal: AbortSignal): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } catch (e) {
    if (!signal.aborted) throw e;
  }
  return text;
}

export function loadConfig(): Config {
  const fs = require('node:fs');
  let cfg: Partial<Config> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(new URL('./bookorbit.json', import.meta.url), 'utf8'));
  } catch {}
  const url = process.env.BOOKORBIT_URL || cfg.url;
  if (!url) fail('no BookOrbit URL: set BOOKORBIT_URL or "url" in bookorbit.json');
  return { url: url!, people: cfg.people ?? {} };
}

export function findPerson(cfg: Config, name: string): Person & { name: string } {
  const want = norm(name).split(' ')[0];
  const key = Object.keys(cfg.people).find((k) => norm(k) === want);
  if (!key) fail(`no family member "${name}" in bookorbit.json (known: ${Object.keys(cfg.people).join(', ')})`);
  return { name: key!, ...cfg.people[key!] };
}

export function describe(r: any) {
  return {
    requestId: r.id,
    title: r.title,
    authors: (r.authors ?? []).join(', '),
    kind: r.mediaKind,
    for: r.requesterName ?? r.requesterUsername,
    library: r.targetLibraryName ?? undefined,
    requested: r.createdAt?.slice(0, 10),
    status: STATUS[r.status] ?? r.status,
    reason: r.status === 'failed' || r.status === 'rejected' ? (r.statusReason ?? r.decisionNote ?? undefined) : undefined,
    pairedWith: r.companionRequestId ?? undefined,
  };
}

export function workPayload(c: any) {
  return {
    title: c.title ?? c.displayTitle,
    subtitle: c.subtitle ?? null,
    authors: c.authors ?? [],
    seriesName: c.seriesName ?? null,
    seriesIndex: intOrNull(c.seriesIndex),
    isbn10: c.isbn10 ?? null,
    isbn13: c.isbn13 ?? null,
    publishedYear: c.publishedYear ?? null,
    coverUrl: typeof c.coverUrl === 'string' && /^https?:\/\//.test(c.coverUrl) ? c.coverUrl : null,
    providerKey: c.provider,
    providerId: String(c.providerId),
    metadataSources: [],
  };
}

async function search(c: Client, q: string, opts: Record<string, string>) {
  const kind = (opts.kind ?? 'audiobook') as Kind;
  if (kind !== 'audiobook' && kind !== 'ebook') fail('--kind must be audiobook or ebook');
  const qs = new URLSearchParams({ title: q, mediaKind: kind, resultsPerProvider: '5' });
  if (opts.author) qs.set('author', opts.author);
  const raw = await c.stream(`/metadata-fetch/stream?${qs}`, 25_000);
  const seen = new Set<string>();
  const picks: any[] = [];
  for (const r of raw) {
    if (r.mediaKind && r.mediaKind !== kind) continue;
    const key = `${norm(r.title ?? r.displayTitle)}|${norm(r.authors?.[0])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(r);
    if (picks.length >= 6) break;
  }
  let avail: any[] = [];
  if (picks.length) {
    try {
      avail = await c.post('/book-requests/availability', {
        items: picks.map((p) => ({
          title: p.title ?? p.displayTitle,
          mediaKind: kind,
          author: p.authors?.[0],
          isbn13: p.isbn13,
          providerKey: p.provider,
          providerId: String(p.providerId),
        })),
      });
    } catch {}
  }
  return {
    query: q,
    kind,
    results: picks.map((p, i) => ({
      provider: p.provider,
      providerId: String(p.providerId),
      title: p.title ?? p.displayTitle,
      authors: (p.authors ?? []).join(', '),
      year: p.publishedYear ?? null,
      series: p.seriesName ? `${p.seriesName}${p.seriesIndex != null ? ` #${p.seriesIndex}` : ''}` : undefined,
      narrators: kind === 'audiobook' && p.narrators?.length ? p.narrators.join(', ') : undefined,
      hours: p.durationSeconds ? Math.round(p.durationSeconds / 360) / 10 : undefined,
      inOwnersLibrary: avail[i]?.ownedBookId ? true : undefined,
      alreadyRequested: avail[i]?.existingRequestId ? (STATUS[avail[i].existingRequestStatus] ?? avail[i].existingRequestStatus) : undefined,
      about: short(p.description),
    })),
  };
}

export async function main(argv: string[], fetchImpl: Fetch = fetch, cfg: Config = loadConfig()) {
  const { pos, opts } = parseArgs(argv);
  const c = makeClient(cfg.url.replace(/\/+$/, ''), fetchImpl);
  const [cmd, ...rest] = pos;

  switch (cmd) {
    case 'search': {
      const q = rest.join(' ').trim();
      if (!q) fail('usage: search <title> [--author <name>] [--kind audiobook|ebook]');
      return search(c, q, opts);
    }
    case 'request': {
      const [provider, providerId] = rest;
      if (!provider || !providerId) fail('usage: request <provider> <providerId> --for <name> --kind audiobook|ebook|both');
      const kind = opts.kind;
      if (kind !== 'audiobook' && kind !== 'ebook' && kind !== 'both') fail('--kind audiobook|ebook|both is required');
      if (!opts.for) fail('--for <first name> is required (who the book is for)');
      const person = findPerson(cfg, opts.for);
      const cand = await c.get(`/metadata-fetch/lookup?${new URLSearchParams({ provider, id: providerId })}`);
      if (!cand) fail(`no book ${provider}:${providerId} (search again)`);
      const work = { ...workPayload(cand), userId: person.userId };
      if (kind === 'both') {
        const half = { targetLibraryId: person.libraryId };
        const r = await c.post('/book-requests/pairs', { ...work, ebook: half, audiobook: half });
        return {
          done: true,
          for: person.name,
          ebook: { ...describe(r.ebook.request), joinedExisting: r.ebook.subscribed || undefined },
          audiobook: { ...describe(r.audiobook.request), joinedExisting: r.audiobook.subscribed || undefined },
        };
      }
      const r = await c.post('/book-requests', { ...work, mediaKind: kind, targetLibraryId: person.libraryId, preferredFormats: [] });
      return { done: true, ...describe(r.request), joinedExisting: r.subscribed || undefined };
    }
    case 'pending': {
      const res = await c.get('/admin/book-requests?status=pending&limit=20&sortBy=createdAt&sortDir=desc');
      return { pending: (res.items ?? []).map(describe) };
    }
    case 'recent': {
      const take = Math.min(Math.max(Number(opts.take ?? 10) || 10, 1), 30);
      const res = await c.get(`/admin/book-requests?limit=${take}&sortBy=createdAt&sortDir=desc`);
      return { recent: (res.items ?? []).map(describe) };
    }
    case 'approve':
    case 'decline': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) fail(`usage: ${cmd} <requestId>`);
      const r = await c.post(`/admin/book-requests/${id}/${cmd === 'approve' ? 'approve' : 'reject'}`, {});
      return { done: true, ...describe(r.request ?? r) };
    }
    default:
      return fail('usage: search | request | pending | recent | approve | decline (see the header of bookorbit.ts)');
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
