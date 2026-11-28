import { describe as group, expect, it } from 'bun:test';

import { type Config, main, rank } from './shelfmark.ts';

const CFG: Config = { url: 'https://getbooks.example', people: { bavya: 6, anika: 7, abhijeet: 8 } };

const REL = (over: Record<string, any> = {}) => ({
  source: 'direct_download',
  source_id: 'md5a',
  title: 'Fourth Wing',
  format: 'epub',
  size_bytes: 2_200_000,
  language: 'en',
  extra: { downloads: 40 },
  ...over,
});

const fake = (routes: Record<string, any>) => {
  const calls: { method: string; path: string; body?: any }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/api/, '');
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const v = routes[`${method} ${path.split('?')[0]}`];
    if (v === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    if (v?.status && v?.body) return new Response(JSON.stringify(v.body), { status: v.status });
    return new Response(JSON.stringify(v), { status: 200 });
  };
  return { f, calls };
};

group('shelfmark', () => {
  it('searches Direct Download for ebooks and puts English epubs first', async () => {
    const { f, calls } = fake({
      'GET /releases': { releases: [REL({ source_id: 'pdf', format: 'pdf' }), REL({ source_id: 'de', language: 'de' }), REL()] },
    });
    const out: any = await main(['search', 'Fourth', 'Wing', '--author', 'Rebecca Yarros'], f, CFG);
    const q = new URL(`https://x${calls[0].path}`).searchParams;
    expect(q.get('source')).toBe('direct_download');
    expect(q.get('content_type')).toBe('ebook');
    expect(q.get('provider')).toBe('manual');
    expect(q.get('author')).toBe('Rebecca Yarros');
    expect(out.results.map((r: any) => r.sourceId)).toEqual(['md5a', 'pdf', 'de']);
    expect(out.results[0]).toMatchObject({ format: 'epub', sizeMB: 2, downloads: 40 });
  });

  it('uses Prowlarr for audiobooks', async () => {
    const { f, calls } = fake({ 'GET /releases': { releases: [] } });
    const out: any = await main(['search', 'Fourth Wing', '--kind', 'audiobook'], f, CFG);
    expect(new URL(`https://x${calls[0].path}`).searchParams.get('source')).toBe('prowlarr');
    expect(out.results).toEqual([]);
  });

  it('queues the chosen release in the person’s own account', async () => {
    const { f, calls } = fake({ 'GET /releases': { releases: [REL({ source_id: 'other' }), REL()] }, 'POST /releases/download': { status: 'queued' } });
    const out: any = await main(['download', 'direct_download', 'md5a', '--title', 'Fourth Wing', '--kind', 'ebook', '--for', 'Anika'], f, CFG);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ source: 'direct_download', source_id: 'md5a', on_behalf_of_user_id: 7, content_type: 'ebook' });
    expect(out).toMatchObject({ done: true, for: 'anika' });
  });

  it('refuses someone without a Shelfmark account, and a release that is gone', async () => {
    const { f, calls } = fake({ 'GET /releases': { releases: [REL()] } });
    await expect(main(['download', 'direct_download', 'md5a', '--title', 'X', '--kind', 'ebook', '--for', 'Aanya'], f, CFG)).rejects.toThrow(/no Shelfmark account/);
    await expect(main(['download', 'direct_download', 'gone', '--title', 'X', '--kind', 'ebook', '--for', 'bavya'], f, CFG)).rejects.toThrow(/no longer listed/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('summarises the queue, optionally for one person', async () => {
    const { f } = fake({
      'GET /status': {
        downloading: { a: { title: 'Fourth Wing', username: 'anika', progress: 41.6, content_type: 'ebook' } },
        error: { b: { title: 'Iron Flame', username: 'bavya', last_error_message: 'mirror timed out' } },
        complete: {},
      },
    });
    const all: any = await main(['status'], f, CFG);
    expect(all.downloads).toEqual([
      { title: 'Fourth Wing', for: 'anika', kind: 'ebook', state: 'downloading', progress: '42%', note: undefined },
      { title: 'Iron Flame', for: 'bavya', kind: undefined, state: 'failed', progress: undefined, note: 'mirror timed out' },
    ]);
    const mine: any = await main(['status', '--for', 'Bavya'], f, CFG);
    expect(mine.downloads.map((d: any) => d.title)).toEqual(['Iron Flame']);
  });

  it('reports Shelfmark errors plainly', async () => {
    const { f } = fake({ 'GET /status': { status: 401, body: { error: 'Unauthorized' } } });
    await expect(main(['status'], f, CFG)).rejects.toThrow('Shelfmark GET /status -> 401: Unauthorized');
  });

  it('rank keeps Shelfmark order among equals', () => {
    expect(rank([REL({ source_id: '1' }), REL({ source_id: '2' })], 'ebook').map((r) => r.source_id)).toEqual(['1', '2']);
  });
});
