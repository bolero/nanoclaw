import { describe as group, expect, it } from 'bun:test';

import { type Config, cleanTitle, findPerson, lookalike, main, parseArgs, workPayload } from './bookorbit.ts';

type Call = { method: string; url: string; body?: any };

const CFG: Config = {
  url: 'https://books.example',
  people: {
    abhijeet: { userId: 1, libraryId: 1 },
    bavya: { userId: 4, libraryId: 11 },
    anika: { userId: 2, libraryId: 10 },
  },
};

const sse = (events: string[]) => new Response(events.join('\n\n') + '\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const fake = (routes: Record<string, any>) => {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path.split('?')[0]}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const v = routes[key];
    if (v instanceof Response) return v;
    if (v?.status && v?.body) return new Response(JSON.stringify(v.body), { status: v.status });
    return new Response(JSON.stringify(v), { status: 200 });
  };
  return { f, calls };
};

const CAND = {
  provider: 'audible',
  providerId: 'B0ABC',
  title: 'The Wild Robot',
  authors: ['Peter Brown'],
  publishedYear: 2016,
  seriesName: 'The Wild Robot',
  seriesIndex: 1,
  narrators: ['Kate Atwater'],
  durationSeconds: 14400,
  coverUrl: 'https://img.example/c.jpg',
  mediaKind: 'audiobook',
};

const REQ = (over: Record<string, any> = {}) => ({
  id: 7,
  title: 'The Wild Robot',
  authors: ['Peter Brown'],
  mediaKind: 'audiobook',
  requesterName: 'Anika',
  targetLibraryName: 'Anika',
  status: 'pending',
  createdAt: '2026-11-27T10:00:00Z',
  companionRequestId: null,
  ...over,
});

group('bookorbit tool', () => {
  it('parses flags and finds people by first name', () => {
    expect(parseArgs(['search', 'wild', 'robot', '--kind', 'ebook'])).toEqual({ pos: ['search', 'wild', 'robot'], opts: { kind: 'ebook' } });
    expect(() => parseArgs(['request', '--for'])).toThrow(/needs a value/);
    expect(findPerson(CFG, 'Anika B')).toEqual({ name: 'anika', userId: 2, libraryId: 10 });
    expect(() => findPerson(CFG, 'Zed')).toThrow(/no family member/);
  });

  it('maps a candidate to a request body', () => {
    expect(workPayload({ ...CAND, seriesIndex: 1.5, coverUrl: 'data:x' })).toMatchObject({
      title: 'The Wild Robot',
      providerKey: 'audible',
      providerId: 'B0ABC',
      seriesIndex: null,
      coverUrl: null,
    });
  });

  it('searches the stream, drops duplicates and other media, and annotates availability', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/stream': sse([
        'event: provider-status\ndata: {"provider":"audible","outcome":"ok"}',
        `data: ${JSON.stringify(CAND)}`,
        `data: ${JSON.stringify({ ...CAND, provider: 'google', providerId: 'g1' })}`,
        `data: ${JSON.stringify({ ...CAND, providerId: 'e1', title: 'The Wild Robot Escapes', mediaKind: 'ebook' })}`,
        `data: ${JSON.stringify({ ...CAND, providerId: 'B0DEF', title: 'The Wild Robot Escapes' })}`,
      ]),
      'POST /book-requests/availability': [
        { ownedBookId: 12, existingRequestId: null },
        { ownedBookId: null, existingRequestId: 3, existingRequestStatus: 'downloading' },
      ],
    });
    const out: any = await main(['search', 'wild', 'robot'], f, CFG);
    expect(calls[0].url).toContain('mediaKind=audiobook');
    expect(out.results.map((r: any) => r.providerId)).toEqual(['B0ABC', 'B0DEF']);
    expect(out.results[0]).toMatchObject({ inAFamilyLibrary: true, narrators: 'Kate Atwater', hours: 4, series: 'The Wild Robot #1' });
    expect(out.results[1].alreadyRequested).toBe('downloading');
    expect(calls[1].body.items).toHaveLength(2);
  });

  it('files an audiobook for a child into her library and approves it', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ(), subscribed: false },
      'POST /admin/book-requests/7/approve': REQ({ status: 'approved' }),
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'Anika', '--kind', 'audiobook'], f, CFG);
    expect(calls[0].url).toBe('/metadata-fetch/lookup?provider=audible&id=B0ABC');
    expect(calls[2].body).toMatchObject({ userId: 2, mediaKind: 'audiobook', targetLibraryId: 10, title: 'The Wild Robot' });
    expect(calls[3]).toMatchObject({ method: 'POST', url: '/admin/book-requests/7/approve', body: {} });
    expect(out).toMatchObject({ done: true, for: 'Anika', requestId: 7, library: 'Anika', status: 'approved, looking for a download' });
  });

  it('does not approve a parent request again, or one that joined an existing request', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ({ status: 'approved', requesterName: 'Abhijeet', targetLibraryName: 'Abhijeet' }), subscribed: false },
      'GET /admin/book-requests/7/releases': { releases: [] },
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'abhijeet', '--kind', 'ebook'], f, CFG);
    expect(calls[2].body).toMatchObject({ userId: 1, mediaKind: 'ebook', targetLibraryId: 1 });
    expect(calls.map((c) => c.url)).not.toContain('/admin/book-requests/7/approve');
    expect(out).toMatchObject({ status: 'approved, looking for a download', download: 'no releases found', tryShelfmark: true });

    const j = fake({ 'GET /metadata-fetch/lookup': CAND, 'POST /book-requests': { request: REQ(), subscribed: true } });
    const out2: any = await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'audiobook'], j.f, CFG);
    expect(j.calls).toHaveLength(3);
    expect(out2.joinedExisting).toBe(true);
  });

  it('files both formats as a pair', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests/pairs': {
        ebook: { request: REQ({ id: 8, mediaKind: 'ebook', status: 'approved' }), subscribed: false },
        audiobook: { request: REQ({ id: 9, status: 'approved' }), subscribed: true },
      },
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'bavya', '--kind', 'both'], f, CFG);
    expect(calls[2].body).toMatchObject({ userId: 4, ebook: { targetLibraryId: 11 }, audiobook: { targetLibraryId: 11 } });
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);
    expect(out.ebook.requestId).toBe(8);
    expect(out.audiobook.joinedExisting).toBe(true);
  });

  it('approves both halves of a pair for a child', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests/pairs': {
        ebook: { request: REQ({ id: 8, mediaKind: 'ebook' }), subscribed: false },
        audiobook: { request: REQ({ id: 9 }), subscribed: false },
      },
      'POST /admin/book-requests/8/approve': REQ({ id: 8, mediaKind: 'ebook', status: 'approved' }),
      'POST /admin/book-requests/9/approve': REQ({ id: 9, status: 'approved' }),
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'both'], f, CFG);
    const approvals = calls.map((c) => c.url).filter((u) => u.endsWith('/approve'));
    expect(approvals).toEqual(['/admin/book-requests/8/approve', '/admin/book-requests/9/approve']);
    expect(out.ebook.status).toBe('approved, looking for a download');
    expect(out.audiobook.status).toBe('approved, looking for a download');
  });

  const REL = (over: Record<string, any> = {}) => ({
    indexerId: 3,
    indexerName: 'NZBgeek',
    guid: 'g-1',
    title: 'Peter Brown - The Wild Robot (2016) [m4b]',
    sizeBytes: 412_000_000,
    seeders: null,
    format: 'm4b',
    formats: ['m4b'],
    alreadyGrabbed: false,
    score: 91,
    profileMismatch: null,
    ...over,
  });

  it('grabs the best release when it scores 80 or more', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ(), subscribed: false },
      'POST /admin/book-requests/7/approve': REQ({ status: 'approved' }),
      'GET /admin/book-requests/7/releases': {
        releases: [REL({ guid: 'low', score: 60 }), REL({ guid: 'used', score: 99, alreadyGrabbed: true }), REL()],
      },
      'POST /admin/book-requests/7/grab': REQ({ status: 'grabbed' }),
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'audiobook'], f, CFG);
    expect(calls.at(-1)).toMatchObject({ url: '/admin/book-requests/7/grab', body: { indexerId: 3, releaseGuid: 'g-1' } });
    expect(out).toMatchObject({ status: 'download found', grabbed: { guid: 'g-1', sizeMB: 412, score: 91 } });
  });

  it('offers the top three when nothing scores 80, and grabs the chosen one', async () => {
    const releases = [REL({ guid: 'a', score: 70 }), REL({ guid: 'b', score: 75 }), REL({ guid: 'c', score: 40 }), REL({ guid: 'd', score: 10 })];
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ({ status: 'approved' }), subscribed: false },
      'GET /admin/book-requests/7/releases': { releases },
      'POST /admin/book-requests/7/grab': REQ({ status: 'grabbed' }),
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'bavya', '--kind', 'audiobook'], f, CFG);
    expect(out.download).toBe('choose a release');
    expect(out.choices.map((r: any) => r.guid)).toEqual(['b', 'a', 'c']);
    expect(calls.some((c) => c.url.endsWith('/grab'))).toBe(false);

    const g: any = await main(['grab', '7', '3', 'b'], f, CFG);
    expect(calls.at(-1)).toMatchObject({ url: '/admin/book-requests/7/grab', body: { indexerId: 3, releaseGuid: 'b' } });
    expect(g).toMatchObject({ done: true, status: 'download found' });
  });

  it('still reports the request when the release search fails', async () => {
    const { f } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ({ status: 'approved' }), subscribed: false },
      'GET /admin/book-requests/7/releases': { status: 502, body: { message: 'Prowlarr is down' } },
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'bavya', '--kind', 'audiobook'], f, CFG);
    expect(out).toMatchObject({ done: true, requestId: 7 });
    expect(out.download).toMatch(/release search failed: .*502: Prowlarr is down/);
  });

  it('lists releases for a request', async () => {
    const { f, calls } = fake({ 'GET /admin/book-requests/7/releases': { releases: [REL({ guid: 'x', score: 50 }), REL()] } });
    const out: any = await main(['releases', '7', '--refresh', 'yes'], f, CFG);
    expect(calls[0].url).toBe('/admin/book-requests/7/releases?refresh=true');
    expect(out.releases.map((r: any) => r.guid)).toEqual(['g-1', 'x']);
  });

  it('links a Shelfmark download in the right dock to its request', async () => {
    const req = REQ({ id: 7, status: 'approved', targetLibraryId: 10, createdAt: '2026-11-27T10:00:00Z' });
    const { f, calls } = fake({
      'GET /book-requests/7': req,
      'GET /book-dock/files': {
        items: [
          { id: 40, fileName: 'Wild Robot.epub', status: 'filed', targetLibraryId: 1, createdAt: '2026-11-27T10:05:00Z', selectedMetadata: { title: 'The Wild Robot' } },
          { id: 41, fileName: 'Wild Robot.epub', status: 'filed', targetLibraryId: 10, createdAt: '2026-11-26T10:05:00Z', selectedMetadata: { title: 'The Wild Robot' } },
          { id: 42, fileName: 'Peter Brown - The Wild Robot.epub', status: 'filed', targetLibraryId: 10, createdAt: '2026-11-27T10:06:00Z', selectedMetadata: null },
        ],
      },
      'POST /admin/book-requests/7/fulfill': REQ({ status: 'available' }),
    });
    const out: any = await main(['link', '7'], f, CFG);
    expect(calls[1].url).toContain('search=The+Wild+Robot');
    expect(calls.at(-1)).toMatchObject({ url: '/admin/book-requests/7/fulfill', body: { bookDockFileId: 42 } });
    expect(out).toMatchObject({ done: true, status: 'in the library', dockFile: 'Peter Brown - The Wild Robot.epub' });

    const none = fake({ 'GET /book-requests/7': req, 'GET /book-dock/files': { items: [] } });
    expect(await main(['link', '7'], none.f, CFG)).toMatchObject({ done: false, reason: 'not in the Library Dock yet' });
  });

  it('watch wakes once per request that reached the library or failed; link marks its own', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const state = `${fs.mkdtempSync(`${os.tmpdir()}/bow-`)}/w.json`;
    const list = (...items: any[]) => fake({ 'GET /admin/book-requests': { items } }).f;
    const run = (...items: any[]) => main(['watch', '--state', state], list(...items), CFG) as Promise<any>;
    expect(await run(REQ({ id: 1, status: 'downloading' }), REQ({ id: 2, status: 'available' }))).toEqual({ wakeAgent: false, data: { finished: [] } });
    expect((await run(REQ({ id: 1, status: 'importing' }), REQ({ id: 2, status: 'available' }))).wakeAgent).toBe(false);
    const out = await run(REQ({ id: 1, status: 'available' }), REQ({ id: 2, status: 'available' }), REQ({ id: 3, status: 'failed' }), REQ({ id: 4, status: 'approved' }));
    expect(out.wakeAgent).toBe(true);
    expect(out.data.finished.map((r: any) => [r.requestId, r.status])).toEqual([[1, 'in the library'], [3, 'failed']]);
    expect((await run(REQ({ id: 1, status: 'available' }), REQ({ id: 3, status: 'failed' }))).wakeAgent).toBe(false);

    // a Shelfmark download linked by the agent is not announced again
    const req = REQ({ id: 4, status: 'approved', targetLibraryId: 10, createdAt: '2026-11-27T10:00:00Z' });
    const linker = fake({
      'GET /book-requests/4': req,
      'GET /book-dock/files': { items: [{ id: 50, fileName: 'x.epub', status: 'filed', targetLibraryId: 10, createdAt: '2026-11-27T10:06:00Z', selectedMetadata: { title: req.title } }] },
      'POST /admin/book-requests/4/fulfill': REQ({ id: 4, status: 'available' }),
    });
    expect(await main(['link', '4', '--state', state], linker.f, CFG)).toMatchObject({ done: true });
    expect((await run(REQ({ id: 4, status: 'available' }))).wakeAgent).toBe(false);
  });

  it('check reports a request, linking a finished Shelfmark file first', async () => {
    const one = (r: any, extra: any = {}) => fake({ 'GET /book-requests/7': r, ...extra }).f;
    expect(await main(['check', '7'], one(REQ({ status: 'available' })), CFG)).toEqual({ state: 'done', detail: 'The Wild Robot (audiobook, for Anika): in the library' });
    expect(await main(['check', '7'], one(REQ({ status: 'failed', statusReason: 'no releases' })), CFG)).toEqual({
      state: 'failed',
      detail: 'The Wild Robot (audiobook, for Anika): failed (no releases)',
    });
    const approved = REQ({ status: 'approved', targetLibraryId: 10 });
    expect(await main(['check', '7'], one(approved, { 'GET /book-dock/files': { items: [] } }), CFG)).toMatchObject({ state: 'pending' });
    const dock = { items: [{ id: 42, fileName: 'x.m4b', status: 'filed', targetLibraryId: 10, createdAt: '2026-11-27T10:06:00Z', selectedMetadata: { title: 'The Wild Robot' } }] };
    expect(await main(['check', '7'], one(approved, { 'GET /book-dock/files': dock, 'POST /admin/book-requests/7/fulfill': REQ({ status: 'available' }) }), CFG)).toMatchObject({ state: 'done' });
  });

  it('requires --kind and --for', async () => {
    const { f } = fake({});
    await expect(main(['request', 'audible', 'B0ABC', '--for', 'anika'], f, CFG)).rejects.toThrow(/--kind/);
    await expect(main(['request', 'audible', 'B0ABC', '--kind', 'ebook'], f, CFG)).rejects.toThrow(/--for/);
  });

  it('lists pending and approves or declines by id', async () => {
    const { f, calls } = fake({
      'GET /admin/book-requests': { items: [REQ()], total: 1 },
      'POST /admin/book-requests/7/approve': REQ({ status: 'approved' }),
      'POST /admin/book-requests/7/reject': REQ({ status: 'rejected', decisionNote: null, statusReason: null }),
    });
    const p: any = await main(['pending'], f, CFG);
    expect(calls[0].url).toContain('status=pending');
    expect(p.pending[0]).toMatchObject({ requestId: 7, for: 'Anika', status: 'waiting for a parent' });
    expect(await main(['approve', '7'], f, CFG)).toMatchObject({ done: true, status: 'approved, looking for a download' });
    expect(await main(['decline', '7'], f, CFG)).toMatchObject({ done: true, status: 'declined' });
    expect(calls.at(-1)?.url).toBe('/admin/book-requests/7/reject');
  });

  it('reports API errors with the message', async () => {
    const { f } = fake({ 'GET /admin/book-requests': { status: 403, body: { message: 'This API key is read-only' } } });
    await expect(main(['recent'], f, CFG)).rejects.toThrow(/403: This API key is read-only/);
  });
});

group('lookalike listings', () => {
  it('spots mixed-script words and overlay marks, not plain accents or other languages', () => {
    expect(lookalike('Peculiar Star\u0334s')).toBe(true);
    expect(lookalike('R\u0435b\u0435\u0441\u0441a Yarros')).toBe(true);
    expect(lookalike('Peculiar Stars – Zwischen uns die Welt')).toBe(false);
    expect(lookalike('Les Misérables', 'Victor Hugo')).toBe(false);
    expect(lookalike('Война и мир')).toBe(false);
  });

  it('hides them from search and refuses a request for one', async () => {
    const fakeCand = { ...CAND, providerId: 'FAKE', authors: ['P\u0435ter Brown'] };
    const { f } = fake({
      'GET /metadata-fetch/stream': sse([`data: ${JSON.stringify(fakeCand)}`, `data: ${JSON.stringify(CAND)}`]),
      'POST /book-requests/availability': [{}],
      'GET /metadata-fetch/lookup': fakeCand,
    });
    const out: any = await main(['search', 'wild', 'robot'], f, CFG);
    expect(out.results.map((r: any) => r.providerId)).toEqual(['B0ABC']);
    expect(out.hiddenLookalikes).toBe(1);
    await expect(main(['request', 'audible', 'FAKE', '--for', 'anika', '--kind', 'audiobook'], f, CFG)).rejects.toThrow(/lookalike/);
  });

  it('says why an approved knock-off request finds nothing', async () => {
    const req = REQ({ status: 'pending', title: 'Peculiar Star\u0334s' });
    const { f } = fake({
      'POST /admin/book-requests/7/approve': { request: { ...req, status: 'approved' } },
      'GET /admin/book-requests/7/releases': { releases: [] },
    });
    const out: any = await main(['approve', '7'], f, CFG);
    expect(out.fakeListing).toMatch(/lookalike/);
    expect(out.tryShelfmark).toBeUndefined();
  });
});

group('titles', () => {
  it('drops store padding', () => {
    expect(cleanTitle('Peculiar Stars: A Novel (Unabridged)')).toBe('Peculiar Stars');
    expect(cleanTitle('Onyx Storm [Abridged]')).toBe('Onyx Storm');
    expect(cleanTitle('Novel Ideas: A Novel Approach')).toBe('Novel Ideas: A Novel Approach');
  });
});

group('cancel', () => {
  it('cancels an approved request and keeps any files', async () => {
    const { f, calls } = fake({ 'POST /book-requests/7/cancel': { ...REQ({ status: 'cancelled' }) } });
    const out: any = await main(['cancel', '7'], f, CFG);
    expect(calls[0].body).toEqual({ deleteFiles: false });
    expect(out).toMatchObject({ done: true, requestId: 7, status: 'cancelled' });
  });
});

group('preferred formats', () => {
  it('asks for epub and m4b/m4a unless the config says otherwise', async () => {
    const routes = {
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ({ status: 'available' }) },
      'POST /book-requests/pairs': { ebook: { request: REQ({ status: 'available', mediaKind: 'ebook' }) }, audiobook: { request: REQ({ status: 'available' }) } },
    };
    const a = fake(routes);
    await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'both'], a.f, CFG);
    const pair = a.calls.find((c) => c.url === '/book-requests/pairs')!.body;
    expect(pair.ebook.preferredFormats).toEqual(['epub']);
    expect(pair.audiobook.preferredFormats).toEqual(['m4b', 'm4a']);
    const b = fake(routes);
    await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'audiobook'], b.f, { ...CFG, preferredFormats: { audiobook: ['mp3'] } });
    expect(b.calls.find((c) => c.url === '/book-requests')!.body.preferredFormats).toEqual(['mp3']);
  });
});

group('already in their library', () => {
  const base = {
    'GET /metadata-fetch/lookup': CAND,
    'POST /book-requests': { request: REQ({ status: 'approved', mediaKind: 'ebook' }) },
    'GET /admin/book-requests/7/releases': { releases: [] },
  };
  it('files nothing when the person already has that format', async () => {
    const { f, calls } = fake({ ...base, 'GET /books/search': [{ id: 1, title: 'The Wild Robot', authors: ['Peter Brown'], libraryId: 10, formats: ['m4b'] }] });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'audiobook'], f, CFG);
    expect(out).toMatchObject({ done: false, alreadyInLibrary: ['audiobook'] });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('for both, files only the missing half; copies in other libraries do not count', async () => {
    const { f, calls } = fake({
      ...base,
      'GET /books/search': [
        { id: 1, title: 'The Wild Robot', authors: ['Peter Brown'], libraryId: 10, formats: ['m4b'] },
        { id: 2, title: 'The Wild Robot', authors: ['Peter Brown'], libraryId: 1, formats: ['epub'] },
      ],
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'both'], f, CFG);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/book-requests');
    expect(post.body.mediaKind).toBe('ebook');
    expect(post.body.preferredFormats).toEqual(['epub']);
    expect(out).toMatchObject({ done: true, alreadyInLibrary: ['audiobook'] });
  });
  it('search --for shows what the person already has', async () => {
    const { f } = fake({
      'GET /metadata-fetch/stream': sse([`data: ${JSON.stringify(CAND)}`]),
      'POST /book-requests/availability': [{ ownedBookId: 2 }],
      'GET /books/search': [{ id: 2, title: 'The Wild Robot', authors: ['Peter Brown'], libraryId: 1, formats: ['epub'] }],
    });
    const out: any = await main(['search', 'wild', 'robot', '--for', 'anika'], f, CFG);
    expect(out.results[0]).toMatchObject({ inAFamilyLibrary: true });
    expect(out.results[0].inTheirLibrary).toBeUndefined();
  });
});

group('has', () => {
  const lib = [
    { id: 1, title: 'Exit Strategy', authors: ['Lee Child, Andrew Child'], libraryId: 1, libraryName: 'Abhijeet', formats: ['epub', 'mp3'] },
    { id: 2, title: 'Exit Strategy', authors: ['Lee Child, Andrew Child'], libraryId: 10, libraryName: 'Anika', formats: ['m4b'] },
    { id: 3, title: 'Exit Strategy', authors: ['Someone Else'], libraryId: 11, libraryName: 'Bavya', formats: ['pdf'] },
  ];
  it('lists every family copy with its formats, filtered by author', async () => {
    const { f, calls } = fake({ 'GET /books/search': lib });
    const out: any = await main(['has', 'Exit', 'Strategy', '--author', 'Lee Child'], f, CFG);
    expect(calls[0].url).toBe('/books/search?q=Exit+Strategy');
    expect(out.books).toEqual([
      { title: 'Exit Strategy', authors: 'Lee Child, Andrew Child', library: 'Abhijeet', ebook: true, audiobook: true, formats: 'epub, mp3', series: undefined },
      { title: 'Exit Strategy', authors: 'Lee Child, Andrew Child', library: 'Anika', ebook: undefined, audiobook: true, formats: 'm4b', series: undefined },
    ]);
  });
  it('narrows to one person, and says when nothing is there', async () => {
    const { f } = fake({ 'GET /books/search': lib });
    const out: any = await main(['has', 'Exit Strategy', '--for', 'anika'], f, CFG);
    expect(out.books.map((b: any) => b.library)).toEqual(['Anika']);
    const none: any = await main(['has', 'Exit Strategy', '--for', 'bavya', '--author', 'Lee Child'], f, CFG);
    expect(none).toMatchObject({ found: false, books: [] });
  });
});
