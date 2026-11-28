#!/usr/bin/env bun
/**
 * BookOrbit: ebook and audiobook requests for the family, made by a parent. The OneCLI proxy adds
 * the API key (owner's account, scoped to requesting, auto-approve and managing requests), so this
 * tool holds no secret. A request is filed in the named person's name and lands in that person's own
 * library. Parents' requests are approved by BookOrbit itself; one for a child is approved by this
 * tool right after filing, because a parent asked for it.
 *
 *   bun bookorbit.ts search <title...> [--author <name>] [--kind audiobook|ebook]
 *   bun bookorbit.ts request <provider> <providerId> --for <first name> --kind audiobook|ebook|both
 *   bun bookorbit.ts pending                     requests waiting for a parent
 *   bun bookorbit.ts recent [--take 10]          latest requests and where they are
 *   bun bookorbit.ts approve <requestId>         only when a parent asks
 *   bun bookorbit.ts decline <requestId>         only when a parent asks (pending requests)
 *   bun bookorbit.ts cancel <requestId>          only when a parent asks (approved, not yet in the library)
 *   bun bookorbit.ts releases <requestId> [--refresh yes]       ranked downloads for a request
 *   bun bookorbit.ts grab <requestId> <indexerId> <guid>        download the release a parent chose
 *   bun bookorbit.ts link <requestId>            after a Shelfmark download, close the request with
 *                                                the file in the person's Library Dock
 *
 * After a request is approved the tool looks for releases: one scoring AUTO_GRAB_SCORE or more is
 * grabbed straight away, otherwise the top three come back as `choices` (or `tryShelfmark`).
 *
 * Store listings whose title or author uses lookalike letters (knock-offs) are hidden from search
 * and refused for a request; nothing can be downloaded for them.
 *
 * Config: bookorbit.json next to this file: {"url": "...", "people": {"<first name>": {"userId": N,
 * "libraryId": N}}, "preferredFormats"?: {"ebook": [...], "audiobook": [...]}} (default epub; m4b, m4a). $BOOKORBIT_URL overrides the url. Output is JSON.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Kind = 'audiobook' | 'ebook';
export type Person = { userId: number; libraryId: number };
export type Config = { url: string; people: Record<string, Person>; preferredFormats?: Partial<Record<Kind, string[]>> };

/** BookOrbit scores a preferred format 12 points (another usable format 6), so these lift releases
 * toward the auto-grab score; other formats are still allowed. Override in bookorbit.json. */
export const PREFERRED_FORMATS: Record<Kind, string[]> = { ebook: ['epub'], audiobook: ['m4b', 'm4a'] };
const prefs = (cfg: Config, kind: Kind) => cfg.preferredFormats?.[kind] ?? PREFERRED_FORMATS[kind];

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
/**
 * Knock-off store listings spell a real title or author with lookalike letters (Cyrillic "е" in a
 * Latin word, a combining overlay such as "r̴"). Indexers then search for gibberish and nothing is
 * ever found, so such a listing is hidden from search and refused for a request.
 */
export function lookalike(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => {
    if (!t) return false;
    if (/[\u0334-\u0338]/.test(t)) return true;
    return t.split(/\s+/).some((w) => /[A-Za-z]/.test(w) && /[\u0370-\u03ff\u0400-\u04ff]/.test(w));
  });
}
const candLookalike = (c: any) => lookalike(c?.title ?? c?.displayTitle, ...(c?.authors ?? []));

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
  return { url: url!, people: cfg.people ?? {}, preferredFormats: cfg.preferredFormats };
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

/** Store padding that indexers never use: "Title: A Novel (Unabridged)" becomes "Title". */
export function cleanTitle(t?: string) {
  return (t ?? '')
    .replace(/\s*[([](un)?abridged( edition)?[)\]]\s*$/i, '')
    .replace(/\s*:\s*a novel\s*$/i, '')
    .trim();
}

export function workPayload(c: any) {
  return {
    title: cleanTitle(c.title ?? c.displayTitle),
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

/** BookOrbit's own auto-grab threshold; a release at or above it is grabbed without asking. */
export const AUTO_GRAB_SCORE = 80;
const GRABBABLE = new Set(['approved', 'searching', 'failed']);

const idArg = (v: string | undefined, usage: string) => {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) fail(`usage: ${usage}`);
  return id;
};

export function rankReleases(list: any[]) {
  return list.filter((r) => !r.alreadyGrabbed).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function describeRelease(r: any) {
  return {
    indexerId: r.indexerId,
    guid: r.guid,
    title: short(r.title, 120),
    indexer: r.indexerName,
    format: r.format || (r.formats ?? []).join('/') || undefined,
    sizeMB: r.sizeBytes ? Math.round(r.sizeBytes / 1e6) : undefined,
    seeders: r.seeders ?? undefined,
    language: r.language ?? undefined,
    score: r.score,
    profileMismatch: r.profileMismatch ? true : undefined,
  };
}

/**
 * After approval: look for releases, grab the best one if it scores at least AUTO_GRAB_SCORE,
 * otherwise hand back the top three for a parent to choose (or none, so Shelfmark can be tried).
 * A search failure is reported, never thrown, so the request itself still counts as filed.
 */
export async function fetchFor(c: Client, req: any): Promise<Record<string, unknown>> {
  if (!GRABBABLE.has(req.status)) return {};
  try {
    const res = await c.get(`/admin/book-requests/${req.id}/releases`);
    const ranked = rankReleases(res.releases ?? []);
    const best = ranked[0];
    if (best && (best.score ?? 0) >= AUTO_GRAB_SCORE) {
      const g = await c.post(`/admin/book-requests/${req.id}/grab`, { indexerId: best.indexerId, releaseGuid: best.guid });
      const after = g.request ?? g;
      return { grabbed: describeRelease(best), status: STATUS[after.status] ?? after.status };
    }
    if (!ranked.length) {
      if (candLookalike(req))
        return { download: 'no releases found', fakeListing: 'the title or author uses lookalike letters; decline this request and request again from a clean search result' };
      return { download: 'no releases found', tryShelfmark: true };
    }
    return { download: 'choose a release', choices: ranked.slice(0, 3).map(describeRelease) };
  } catch (e: any) {
    return { download: `release search failed: ${e.message}` };
  }
}

async function search(c: Client, q: string, opts: Record<string, string>) {
  const kind = (opts.kind ?? 'audiobook') as Kind;
  if (kind !== 'audiobook' && kind !== 'ebook') fail('--kind must be audiobook or ebook');
  const qs = new URLSearchParams({ title: q, mediaKind: kind, resultsPerProvider: '5' });
  if (opts.author) qs.set('author', opts.author);
  const raw = await c.stream(`/metadata-fetch/stream?${qs}`, 25_000);
  const seen = new Set<string>();
  const picks: any[] = [];
  let hidden = 0;
  for (const r of raw) {
    if (r.mediaKind && r.mediaKind !== kind) continue;
    if (candLookalike(r)) {
      hidden++;
      continue;
    }
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
    hiddenLookalikes: hidden || undefined,
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
      if (candLookalike(cand)) fail('that listing spells the title or author with lookalike letters (a knock-off); pick another search result');
      const work = { ...workPayload(cand), userId: person.userId };
      // A parent asked, so a request that BookOrbit parks for approval (a child has no
      // auto-approve) is approved straight away. The approval keeps the child's own library.
      const settle = async (res: any) => {
        let req = res.request;
        if (req.status === 'pending' && !res.subscribed) {
          const a = await c.post(`/admin/book-requests/${req.id}/approve`, {});
          req = a.request ?? a;
        }
        return { ...describe(req), joinedExisting: res.subscribed || undefined, ...(await fetchFor(c, req)) };
      };
      if (kind === 'both') {
        const half = (k: Kind) => ({ targetLibraryId: person.libraryId, preferredFormats: prefs(cfg, k) });
        const r = await c.post('/book-requests/pairs', { ...work, ebook: half('ebook'), audiobook: half('audiobook') });
        return { done: true, for: person.name, ebook: await settle(r.ebook), audiobook: await settle(r.audiobook) };
      }
      const r = await c.post('/book-requests', { ...work, mediaKind: kind, targetLibraryId: person.libraryId, preferredFormats: prefs(cfg, kind) });
      return { done: true, ...(await settle(r)) };
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
      const req = r.request ?? r;
      return { done: true, ...describe(req), ...(cmd === 'approve' ? await fetchFor(c, req) : {}) };
    }
    case 'cancel': {
      const id = idArg(rest[0], 'cancel <requestId>');
      const r = await c.post(`/book-requests/${id}/cancel`, { deleteFiles: false });
      return { done: true, ...describe(r.request ?? r) };
    }
    case 'releases': {
      const id = idArg(rest[0], 'releases <requestId>');
      const res = await c.get(`/admin/book-requests/${id}/releases${opts.refresh === 'yes' ? '?refresh=true' : ''}`);
      return { requestId: id, releases: rankReleases(res.releases ?? []).slice(0, 5).map(describeRelease) };
    }
    case 'grab': {
      const id = idArg(rest[0], 'grab <requestId> <indexerId> <guid>');
      const indexerId = Number(rest[1]);
      const guid = rest.slice(2).join(' ');
      if (!Number.isInteger(indexerId) || !guid) fail('usage: grab <requestId> <indexerId> <guid> (from releases)');
      const r = await c.post(`/admin/book-requests/${id}/grab`, { indexerId, releaseGuid: guid });
      return { done: true, ...describe(r.request ?? r) };
    }
    case 'link': {
      // After a Shelfmark download: find the file in the person's Library Dock and close the
      // request with it, so BookOrbit shows the request as done.
      const id = idArg(rest[0], 'link <requestId>');
      const req = await c.get(`/book-requests/${id}`);
      if (req.status === 'available') return { done: true, already: true, ...describe(req) };
      const qs = new URLSearchParams({ search: req.title, limit: '20', sort: 'createdAt', order: 'desc' });
      const files = (await c.get(`/book-dock/files?${qs}`)).items ?? [];
      const since = Date.parse(req.createdAt);
      const want = norm(req.title);
      const hit = files.find(
        (f: any) =>
          (req.targetLibraryId == null || f.targetLibraryId === req.targetLibraryId) &&
          Date.parse(f.createdAt) >= since - 60_000 &&
          [f.selectedMetadata?.title, f.fetchedMetadata?.title, f.embeddedMetadata?.title, f.fileName].some((t) => norm(t ?? '').includes(want)),
      );
      if (!hit) return { done: false, ...describe(req), reason: 'not in the Library Dock yet' };
      const r = await c.post(`/admin/book-requests/${id}/fulfill`, { bookDockFileId: hit.id, note: opts.note ?? 'Downloaded with Shelfmark' });
      return { done: true, dockFile: hit.fileName, dockStatus: hit.status, ...describe(r.request ?? r) };
    }
    default:
      return fail('usage: search | request | pending | recent | approve | decline | cancel | releases | grab | link (see the header of bookorbit.ts)');
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
