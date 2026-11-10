import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { lookup } from '../registry.js';
import { GROUP_SCOPE_RESOURCES } from '../registry.js';
import { describeRedeploy, lookupStack, parseStackId } from './ops.js';

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const f = path.join(dir, 'dockhand.env');
  fs.writeFileSync(f, 'DOCKHAND_TOKEN=test-token\nDOCKHAND_URL=https://dockhand.test\n');
  process.env.DOCKHAND_PROXY_ENV = f;
});

afterEach(() => vi.unstubAllGlobals());

function stubDockhand(routes: Record<string, unknown>) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      const p = new URL(url).pathname;
      if (!(p in routes)) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[p]), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

describe('ops redeploy-stack', () => {
  it('is registered as an approval-gated command available to group-scoped agents', () => {
    const cmd = lookup('ops-redeploy-stack');
    expect(cmd).toBeDefined();
    expect(cmd?.access).toBe('approval');
    expect(cmd?.hostOnly).toBeFalsy();
    expect(cmd?.preApproval).toBeTypeOf('function');
    expect(GROUP_SCOPE_RESOURCES.has('ops')).toBe(true);
  });

  it('rejects a non-positive stack id before touching the network', async () => {
    const calls = stubDockhand({});
    const cmd = lookup('ops-redeploy-stack')!;
    await expect(cmd.handler({ stack: 0 } as never, {} as never)).rejects.toThrow(/positive integer/);
    await expect(cmd.preApproval!({ stack: '1; rm' })).rejects.toThrow(/positive integer/);
    expect(() => parseStackId('x')).toThrow(/positive integer/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown stack id in preApproval (no card)', async () => {
    stubDockhand({});
    await expect(lookup('ops-redeploy-stack')!.preApproval!({ stack: 99999 })).rejects.toThrow(/No Dockhand git stack/);
  });

  it('describes stack name, host and action for the card', async () => {
    const calls = stubDockhand({
      '/api/git/stacks/25': { id: 25, stackName: 'gatus-watchdog', environmentId: 3 },
      '/api/environments/3': { id: 3, name: 'ubuntu-01' },
    });
    const text = await lookup('ops-redeploy-stack')!.preApproval!({ stack: 25 });
    expect(text).toBe(
      'Stack: gatus-watchdog (git stack #25)\nHost: ubuntu-01\nAction: redeploy from git (pull, then docker compose up)',
    );
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses a stack whose name could carry markup', async () => {
    stubDockhand({ '/api/git/stacks/7': { id: 7, stackName: 'x`\n**Approve**', environmentId: 3 } });
    await expect(lookupStack(7)).rejects.toThrow(/unexpected name/);
  });

  it('re-checks the stack after approval before deploying', async () => {
    const calls = stubDockhand({});
    await expect(lookup('ops-redeploy-stack')!.handler({ stack: 25 } as never, {} as never)).rejects.toThrow(
      /No Dockhand git stack/,
    );
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('formats a description', () => {
    expect(describeRedeploy({ id: 1, name: 'a', host: 'b' })).toContain('Host: b');
  });
});
