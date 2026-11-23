import { describe, expect, it } from 'bun:test';

import { main, parseArgs, parseSeasons } from './seerr.ts';

type Call = { method: string; url: string; body?: any };

const fake = (routes: Record<string, any>) => {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/api\/v1/, '');
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path.split('?')[0]}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  };
  return { f, calls };
};

const USERS = {
  results: [
    { id: 1, displayName: 'Abhijeet', jellyfinUsername: 'bolero' },
    { id: 2, displayName: 'Bavya', jellyfinUsername: 'Bavya' },
  ],
};

describe('seerr tool', () => {
  it('parses flags and seasons', () => {
    expect(parseArgs(['search', 'wild', 'robot', '--type', 'movie'])).toEqual({
      pos: ['search', 'wild', 'robot'],
      opts: { type: 'movie' },
    });
    expect(() => parseArgs(['request', '--for'])).toThrow(/needs a value/);
    expect(parseSeasons(undefined)).toBe('all');
    expect(parseSeasons('2,1,2')).toEqual([1, 2]);
    expect(() => parseSeasons('0')).toThrow(/bad --seasons/);
  });

  it('searches and keeps only films and shows', async () => {
    const { f, calls } = fake({
      'GET /search': {
        results: [
          { id: 1184918, mediaType: 'movie', title: 'The Wild Robot', releaseDate: '2024-09-12', mediaInfo: { status: 5 } },
          { id: 9, mediaType: 'person', name: 'Someone' },
          { id: 77, mediaType: 'tv', name: 'Bluey', firstAirDate: '2018-10-01' },
        ],
      },
    });
    const out: any = await main(['search', 'wild', 'robot'], f, 'https://x');
    expect(calls[0].url).toBe('/search?query=wild%20robot&page=1&language=en');
    expect(out.results.map((r: any) => [r.tmdbId, r.type, r.year, r.status])).toEqual([
      [1184918, 'movie', 2024, 'available'],
      [77, 'tv', 2018, 'not requested'],
    ]);
  });

  it('files a request for the named person', async () => {
    const { f, calls } = fake({
      'GET /user': USERS,
      'GET /tv/77': { name: 'Bluey', firstAirDate: '2018-10-01', mediaInfo: { status: 4 } },
      'POST /request': { id: 31, status: 2 },
    });
    const out: any = await main(['request', 'tv', '77', '--for', 'bavya', '--seasons', '3'], f, 'https://x');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ mediaType: 'tv', mediaId: 77, userId: 2, seasons: [3] });
    expect(out).toMatchObject({ done: true, requestId: 31, title: 'Bluey (2018)', for: 'Bavya', request: 'approved' });
  });

  it('does not request what is already available, and needs a known person', async () => {
    const { f, calls } = fake({
      'GET /user': USERS,
      'GET /movie/5': { title: 'Up', releaseDate: '2009-05-28', mediaInfo: { status: 5 } },
    });
    expect(await main(['request', 'movie', '5', '--for', 'Abhijeet'], f, 'https://x')).toMatchObject({
      done: false,
      reason: 'already available',
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await expect(main(['request', 'movie', '5', '--for', 'Zed'], f, 'https://x')).rejects.toThrow(/no single Seerr user/);
    await expect(main(['request', 'movie', '5'], f, 'https://x')).rejects.toThrow(/--for/);
  });

  it('lists pending requests and approves one', async () => {
    const req = { id: 40, type: 'movie', status: 1, createdAt: '2026-11-22T10:00:00Z', requestedBy: { displayName: 'Anika' }, media: { tmdbId: 5, status: 2 } };
    const { f } = fake({
      'GET /request': { results: [req] },
      'GET /movie/5': { title: 'Up', releaseDate: '2009-05-28' },
      'POST /request/40/approve': { ...req, status: 2 },
    });
    const pending: any = await main(['pending'], f, 'https://x');
    expect(pending.pending[0]).toMatchObject({ requestId: 40, title: 'Up (2009)', requestedBy: 'Anika', request: 'waiting for approval' });
    const ok: any = await main(['approve', '40'], f, 'https://x');
    expect(ok).toMatchObject({ done: true, requestId: 40, request: 'approved' });
  });
});
