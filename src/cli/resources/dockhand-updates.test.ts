import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { lookup } from '../registry.js';
import { parseImageRef, remoteVersion, resolveUpdate, summarizeBatch, versionFromConfig } from './dockhand-updates.js';
import './ops.js';

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-upd-'));
  const f = path.join(dir, 'dockhand.env');
  fs.writeFileSync(f, 'DOCKHAND_TOKEN=test-token\nDOCKHAND_URL=https://dockhand.test\n');
  process.env.DOCKHAND_PROXY_ENV = f;
});

afterEach(() => vi.unstubAllGlobals());

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

const CONTAINERS = [
  { id: 'c1', name: 'homepage', image: 'ghcr.io/gethomepage/homepage:latest', labels: {} },
  { id: 'c2', name: 'outline-redis', image: 'redis:7-alpine', labels: {} },
  { id: 'c3', name: 'portfolio', image: 'nginx:alpine', labels: {} },
  { id: 'c4', name: 'pinned', image: 'foo/bar@sha256:' + 'a'.repeat(64), labels: {} },
  { id: 'c5', name: 'optout', image: 'foo/baz:1', labels: { 'dockhand.update': 'false' } },
];
const PENDING = {
  pendingUpdates: [
    { containerId: 'c1', containerName: 'homepage', hasImageUpdate: true, checkedAt: '2026-11-13T12:00:00Z' },
    { containerId: 'c2', containerName: 'outline-redis', hasImageUpdate: true, checkedAt: '2026-11-13T12:00:00Z' },
    { containerId: 'c4', containerName: 'pinned', hasImageUpdate: true, pinnedToDigest: true },
    { containerId: 'c5', containerName: 'optout', hasImageUpdate: true },
  ],
};

function stubDockhand(
  batch: unknown = { results: [{ containerId: 'c1', success: true }], summary: { total: 1, success: 1, failed: 0 } },
) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      const u = new URL(url);
      if (u.pathname === '/api/environments/3') return json({ id: 3, name: 'ubuntu-01' });
      if (u.pathname === '/api/containers' && u.searchParams.get('env') === '3') return json(CONTAINERS);
      if (u.pathname === '/api/containers/pending-updates') return json(PENDING);
      if (u.pathname === '/api/containers/batch-update' && init?.method === 'POST') return json(batch);
      return new Response('nf', { status: 404 });
    }),
  );
  return calls;
}

describe('ops update-containers', () => {
  it('is approval-gated; image-versions is open', () => {
    expect(lookup('ops-update-containers')?.access).toBe('approval');
    expect(lookup('ops-update-containers')?.preApproval).toBeTypeOf('function');
    expect(lookup('ops-image-versions')?.access).toBe('open');
  });

  it('describes host, containers and the no-rollback caveat', async () => {
    const calls = stubDockhand();
    const text = await lookup('ops-update-containers')!.preApproval!({ env: 3, containers: 'homepage' });
    expect(text).toContain('Host: ubuntu-01 (Dockhand env 3)');
    expect(text).toContain('- homepage: ghcr.io/gethomepage/homepage:latest');
    expect(text).toContain('no automatic rollback');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it.each([
    ['outline-redis', /--include-risky/],
    ['portfolio', /no pending image update/],
    ['pinned', /pinned to a digest/],
    ['optout', /dockhand.update=false/],
    ['ghost', /no such container/],
  ])('refuses %s', async (name, why) => {
    stubDockhand();
    await expect(resolveUpdate({ env: 3, containers: name })).rejects.toThrow(why);
  });

  it('allows a risky container with --include-risky and marks it on the card', async () => {
    stubDockhand();
    const text = await lookup('ops-update-containers')!.preApproval!({
      env: 3,
      containers: 'outline-redis',
      'include-risky': true,
    });
    expect(text).toContain('[RISKY');
  });

  it('rejects bad input before the network', async () => {
    const calls = stubDockhand();
    await expect(resolveUpdate({ env: 0, containers: 'homepage' })).rejects.toThrow(/positive integer/);
    await expect(resolveUpdate({ env: 3, containers: 'a;rm -rf' })).rejects.toThrow(/unexpected characters/);
    await expect(
      resolveUpdate({ env: 3, containers: Array.from({ length: 11 }, (_, i) => `c${i}`).join(',') }),
    ).rejects.toThrow(/at most 10/);
    expect(calls).toHaveLength(0);
  });

  it('re-checks after approval, then posts only the resolved ids', async () => {
    const calls = stubDockhand();
    const out = await lookup('ops-update-containers')!.handler(
      { env: 3, containers: 'homepage' } as never,
      {} as never,
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://dockhand.test/api/containers/batch-update?env=3');
    expect(JSON.parse(post.body!)).toEqual({ containerIds: ['c1'] });
    expect(out).toContain('- homepage: updated');
  });

  it('never posts when the re-check fails', async () => {
    const calls = stubDockhand();
    await expect(
      lookup('ops-update-containers')!.handler({ env: 3, containers: 'portfolio' } as never, {} as never),
    ).rejects.toThrow();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('summarizes failures', () => {
    const plan = {
      env: 3,
      host: 'ubuntu-01',
      items: [{ id: 'c1', name: 'homepage', image: 'x', checkedAt: '', risky: false }],
    };
    expect(
      summarizeBatch(plan, JSON.stringify({ results: [{ containerId: 'c1', success: false, error: 'pull\nfailed' }] })),
    ).toContain('- homepage: FAILED (pull failed)');
  });
});

describe('image versions', () => {
  it('parses image references', () => {
    expect(parseImageRef('postgres:16-alpine')).toEqual({
      registry: 'registry-1.docker.io',
      repo: 'library/postgres',
      tag: '16-alpine',
    });
    expect(parseImageRef('ghcr.io/open-webui/open-webui:main')).toEqual({
      registry: 'ghcr.io',
      repo: 'open-webui/open-webui',
      tag: 'main',
    });
    expect(parseImageRef('lscr.io/linuxserver/plex')).toEqual({
      registry: 'lscr.io',
      repo: 'linuxserver/plex',
      tag: 'latest',
    });
    expect(parseImageRef('localhost:5000/app:1')).toEqual({ registry: 'localhost:5000', repo: 'app', tag: '1' });
    expect(parseImageRef('foo@sha256:abc')).toBeNull();
  });

  it('reads the OCI label, then known *_VERSION env', () => {
    expect(versionFromConfig({ Labels: { 'org.opencontainers.image.version': 'v1.2.3' } })).toBe('v1.2.3');
    expect(versionFromConfig({ Env: ['PATH=/x', 'PG_VERSION=16.11'] })).toBe('16.11');
    expect(versionFromConfig({ Env: ['SECRET_VERSION=nope'] })).toBeNull();
    expect(versionFromConfig({ Labels: { 'org.opencontainers.image.version': 'main' } })).toBeNull();
    expect(versionFromConfig({ Labels: { 'org.opencontainers.image.version': '`**x**`' } })).toBeNull();
  });

  it('follows the anonymous token flow and picks the linux/amd64 manifest', async () => {
    const d = (c: string) => 'sha256:' + c.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.authorization;
        if (url.startsWith('https://auth.docker.io/token')) return json({ token: 't' });
        if (!auth)
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/redis:pull"',
            },
          });
        if (url.endsWith('/manifests/7-alpine'))
          return json({
            manifests: [
              { digest: d('b'), platform: { os: 'linux', architecture: 'arm64' } },
              { digest: d('a'), platform: { os: 'linux', architecture: 'amd64' } },
            ],
          });
        if (url.endsWith(`/manifests/${d('a')}`)) return json({ config: { digest: d('c') } });
        if (url.endsWith(`/blobs/${d('c')}`)) return json({ config: { Env: ['REDIS_VERSION=7.4.6'] } });
        return new Response('nf', { status: 404 });
      }),
    );
    expect(await remoteVersion('redis:7-alpine')).toEqual({ version: '7.4.6' });
  });
});
