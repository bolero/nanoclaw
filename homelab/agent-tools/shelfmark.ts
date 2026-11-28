#!/usr/bin/env bun
/**
 * Shelfmark: the direct-download fallback for a BookOrbit request that found no good release.
 * The OneCLI proxy adds Shelfmark's admin API key, so this tool holds no secret. A download is
 * queued in the named person's Shelfmark account, so the file lands in that person's BookOrbit
 * Library Dock (Shelfmark saves to /bookdock/{User}); then `bookorbit link <requestId>` closes
 * the BookOrbit request with it.
 *
 *   bun shelfmark.ts search <title...> [--author <name>] [--kind ebook|audiobook] [--source <name>]
 *   bun shelfmark.ts download <source> <sourceId> --title <t> [--author <a>] --kind ebook|audiobook --for <first name>
 *   bun shelfmark.ts status [--for <first name>]      what is queued, downloading, done or failed
 *
 * Ebooks search Direct Download by default, audiobooks Prowlarr. `download` repeats the search and
 * queues the release with that sourceId, so pass the same title, author and kind as the search.
 *
 * Config: shelfmark.json next to this file: {"url": "...", "people": {"<first name>": <Shelfmark
 * user id>}}. $SHELFMARK_URL overrides the url. Output is JSON.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Kind = 'audiobook' | 'ebook';
export type Config = { url: string; people: Record<string, number> };

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
const short = (s?: string, n = 120) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const DEFAULT_SOURCE: Record<Kind, string> = { ebook: 'direct_download', audiobook: 'prowlarr' };
const SEARCH_TIMEOUT_MS = 100_000;

export function makeClient(base: string, fetchImpl: Fetch) {
  const call = async (method: string, path: string, body?: unknown, timeoutMs = 30_000) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e: any) {
      fail(ctl.signal.aborted ? `Shelfmark ${method} ${path.split('?')[0]} timed out` : `Shelfmark is not answering: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res!.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!res!.ok) fail(`Shelfmark ${method} ${path.split('?')[0]} -> ${res!.status}: ${data?.error ?? data?.message ?? 'error'}`);
    return data;
  };
  return {
    get: (p: string, timeoutMs?: number) => call('GET', p, undefined, timeoutMs),
    post: (p: string, b: unknown) => call('POST', p, b),
  };
}
type Client = ReturnType<typeof makeClient>;

export function loadConfig(): Config {
  const fs = require('node:fs');
  let cfg: Partial<Config> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(new URL('./shelfmark.json', import.meta.url), 'utf8'));
  } catch {}
  const url = process.env.SHELFMARK_URL || cfg.url;
  if (!url) fail('no Shelfmark URL: set SHELFMARK_URL or "url" in shelfmark.json');
  return { url: url!, people: cfg.people ?? {} };
}

export function findPerson(cfg: Config, name: string): { name: string; userId: number } {
  const want = norm(name).split(' ')[0];
  const key = Object.keys(cfg.people).find((k) => norm(k) === want);
  if (!key) fail(`${name} has no Shelfmark account (known: ${Object.keys(cfg.people).join(', ')}); a parent can add one in Shelfmark`);
  return { name: key!, userId: cfg.people[key!] };
}

const kindOf = (v: string | undefined): Kind => {
  const k = v ?? 'ebook';
  if (k !== 'ebook' && k !== 'audiobook') fail('--kind must be ebook or audiobook');
  return k as Kind;
};

const langOf = (r: any): string | undefined => r.language ?? r.extra?.language ?? undefined;

/** English epubs first for ebooks; otherwise Shelfmark's own order. */
export function rank(list: any[], kind: Kind) {
  const score = (r: any) =>
    (/\ben\b/i.test(langOf(r) ?? '') ? 2 : 0) + (kind === 'ebook' && String(r.format ?? '').toLowerCase() === 'epub' ? 1 : 0);
  return list.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
}

export function describeRelease(r: any) {
  return {
    source: r.source,
    sourceId: String(r.source_id),
    title: short(r.title),
    format: r.format ?? r.extra?.formats_display ?? undefined,
    sizeMB: r.size_bytes ? Math.round(r.size_bytes / 1e6) : undefined,
    language: langOf(r),
    seeders: r.seeders ?? undefined,
    downloads: r.extra?.downloads ?? undefined,
    indexer: r.indexer ?? undefined,
  };
}

async function find(c: Client, title: string, opts: Record<string, string>) {
  const kind = kindOf(opts.kind);
  const source = opts.source ?? DEFAULT_SOURCE[kind];
  const qs = new URLSearchParams({ provider: 'manual', book_id: 'family-agent', title, content_type: kind, source });
  if (opts.author) qs.set('author', opts.author);
  const res = await c.get(`/releases?${qs}`, SEARCH_TIMEOUT_MS);
  return { kind, source, releases: rank(res?.releases ?? [], kind) };
}

const STATE: Record<string, string> = {
  queued: 'queued',
  resolving: 'finding the file',
  locating: 'finding the file',
  downloading: 'downloading',
  complete: 'done',
  error: 'failed',
  cancelled: 'cancelled',
};

export async function main(argv: string[], fetchImpl: Fetch = fetch, cfg: Config = loadConfig()) {
  const { pos, opts } = parseArgs(argv);
  const c = makeClient(cfg.url.replace(/\/+$/, ''), fetchImpl);
  const [cmd, ...rest] = pos;

  switch (cmd) {
    case 'search': {
      const title = rest.join(' ').trim();
      if (!title) fail('usage: search <title> [--author <name>] [--kind ebook|audiobook]');
      const { kind, source, releases } = await find(c, title, opts);
      return { query: title, kind, source, results: releases.slice(0, 5).map(describeRelease) };
    }
    case 'download': {
      const [source, sourceId] = rest;
      if (!source || !sourceId || !opts.title) fail('usage: download <source> <sourceId> --title <t> [--author <a>] --kind ebook|audiobook --for <name>');
      if (!opts.for) fail('--for <first name> is required (whose library it goes to)');
      const person = findPerson(cfg, opts.for);
      const { kind, releases } = await find(c, opts.title, { ...opts, source });
      const rel = releases.find((r) => String(r.source_id) === sourceId);
      if (!rel) fail('that release is no longer listed; search again');
      await c.post('/releases/download', { ...rel, content_type: kind, on_behalf_of_user_id: person.userId });
      return { done: true, queued: describeRelease(rel), for: person.name, then: 'when status shows it done, run bookorbit link <requestId> if it was for a BookOrbit request' };
    }
    case 'status': {
      const res = (await c.get('/status')) ?? {};
      const who = opts.for ? findPerson(cfg, opts.for).name : undefined;
      const items: any[] = [];
      for (const [state, tasks] of Object.entries(res as Record<string, any>)) {
        for (const t of Object.values(tasks ?? {}) as any[]) {
          if (who && norm(t.username) !== norm(who)) continue;
          items.push({
            title: short(t.title),
            for: t.username ?? undefined,
            kind: t.content_type ?? undefined,
            state: STATE[state] ?? state,
            progress: state === 'downloading' && typeof t.progress === 'number' ? `${Math.round(t.progress)}%` : undefined,
            note: state === 'error' ? short(t.last_error_message ?? t.status_message, 200) || undefined : undefined,
          });
        }
      }
      return { downloads: items };
    }
    default:
      return fail('usage: search | download | status (see the header of shelfmark.ts)');
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
