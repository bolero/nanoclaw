import { describe as group, expect, it } from 'bun:test';

import { type Config, findPerson, main, parseArgs, workPayload } from './bookorbit.ts';

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
    expect(out.results[0]).toMatchObject({ inOwnersLibrary: true, narrators: 'Kate Atwater', hours: 4, series: 'The Wild Robot #1' });
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
    expect(calls[1].body).toMatchObject({ userId: 2, mediaKind: 'audiobook', targetLibraryId: 10, title: 'The Wild Robot' });
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/admin/book-requests/7/approve', body: {} });
    expect(out).toMatchObject({ done: true, for: 'Anika', requestId: 7, library: 'Anika', status: 'approved, looking for a download' });
  });

  it('does not approve a parent request again, or one that joined an existing request', async () => {
    const { f, calls } = fake({
      'GET /metadata-fetch/lookup': CAND,
      'POST /book-requests': { request: REQ({ status: 'approved', requesterName: 'Abhijeet', targetLibraryName: 'Abhijeet' }), subscribed: false },
    });
    const out: any = await main(['request', 'audible', 'B0ABC', '--for', 'abhijeet', '--kind', 'ebook'], f, CFG);
    expect(calls[1].body).toMatchObject({ userId: 1, mediaKind: 'ebook', targetLibraryId: 1 });
    expect(calls).toHaveLength(2);
    expect(out.status).toBe('approved, looking for a download');

    const j = fake({ 'GET /metadata-fetch/lookup': CAND, 'POST /book-requests': { request: REQ(), subscribed: true } });
    const out2: any = await main(['request', 'audible', 'B0ABC', '--for', 'anika', '--kind', 'audiobook'], j.f, CFG);
    expect(j.calls).toHaveLength(2);
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
    expect(calls[1].body).toMatchObject({ userId: 4, ebook: { targetLibraryId: 11 }, audiobook: { targetLibraryId: 11 } });
    expect(calls).toHaveLength(2);
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
    expect(calls.map((c) => c.url).slice(2)).toEqual(['/admin/book-requests/8/approve', '/admin/book-requests/9/approve']);
    expect(out.ebook.status).toBe('approved, looking for a download');
    expect(out.audiobook.status).toBe('approved, looking for a download');
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
