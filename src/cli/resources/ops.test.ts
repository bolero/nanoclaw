import { describe, expect, it } from 'vitest';

import { lookup } from '../registry.js';
import { GROUP_SCOPE_RESOURCES } from '../registry.js';
import './ops.js';

describe('ops redeploy-stack', () => {
  it('is registered as an approval-gated command available to group-scoped agents', () => {
    const cmd = lookup('ops-redeploy-stack');
    expect(cmd).toBeDefined();
    expect(cmd?.access).toBe('approval');
    expect(cmd?.hostOnly).toBeFalsy();
    expect(GROUP_SCOPE_RESOURCES.has('ops')).toBe(true);
  });

  it('rejects a non-positive stack id before touching the network', async () => {
    const cmd = lookup('ops-redeploy-stack')!;
    await expect(cmd.handler({ stack: 0 } as never, {} as never)).rejects.toThrow(/positive integer/);
    await expect(cmd.handler({ stack: 'x' } as never, {} as never)).rejects.toThrow(/positive integer/);
  });
});
