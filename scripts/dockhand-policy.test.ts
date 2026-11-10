import { describe, expect, it } from 'vitest';

import { checkRequest } from './dockhand-policy.js';

const ok = (url: string, method = 'GET') => checkRequest(method, url).ok;

describe('dockhand proxy policy', () => {
  it.each([
    '/api/health',
    '/api/environments',
    '/api/environments/3',
    '/api/containers?environmentId=3',
    '/api/containers?environmentId=3&all=true',
    '/api/containers/gatus/logs?environmentId=1&tail=200',
    '/api/containers/0123abcd4567/stats?environmentId=1',
    '/api/stacks?environmentId=4',
    '/api/git/stacks',
    '/api/git/stacks/25',
    '/api/activity?environmentId=3&limit=20',
  ])('allows %s', (url) => expect(ok(url)).toBe(true));

  it.each([
    '/api/environments/3/env',
    '/api/containers/gatus', // inspect output carries env vars
    '/api/containers/gatus/env',
    '/api/stacks/web/env',
    '/api/settings',
    '/api/auth/me',
    '/api/users',
    '/api/git/stacks/25/deploy',
    '/api/git/credentials',
    '/api/registries',
    '/api/notifications',
    '/api/dashboard/stats',
    '/api/containers/../settings',
    '/api/containers/%2e%2e/settings',
    '/api//settings',
    '/api/git/stacks/0',
    '/api/containers?environmentId=3&token=x',
    '/api/activity?limit=99999',
    '/api/activity?environmentId=1&environmentId=2',
    '/api/containers/a\\b/logs',
  ])('refuses %s', (url) => expect(ok(url)).toBe(false));

  it('refuses non-read methods', () => {
    expect(checkRequest('POST', '/api/git/stacks/25')).toMatchObject({ ok: false, code: 405 });
    expect(ok('/api/health', 'HEAD')).toBe(true);
  });
});
