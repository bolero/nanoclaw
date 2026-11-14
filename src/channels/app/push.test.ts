import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { ApnsClient, decidePush, inQuietHours, isDeadToken, localHour, parseQuietHours, previewLine } from './push.js';

const config = { quietHours: [21, 7] as [number, number], urgentAgents: ['argus'], timezone: 'UTC' };
const noon = new Date('2026-11-13T12:00:00Z');
const night = new Date('2026-11-13T23:30:00Z');

describe('push policy', () => {
  it('always pushes cards, and agent messages only when the agent spoke first', () => {
    const base = { live: false, agentFolder: 'bono', config, now: noon, createdAt: '2026-11-13T12:00:00Z' };
    expect(decidePush({ ...base, isCard: true, lastInboundAt: '2026-11-13T11:59:00Z' }).send).toBe(true);
    expect(decidePush({ ...base, isCard: false, lastInboundAt: '2026-11-13T11:59:00Z' }).send).toBe(false);
    expect(decidePush({ ...base, isCard: false, lastInboundAt: '2026-11-13T09:00:00Z' }).send).toBe(true);
    expect(decidePush({ ...base, isCard: false, lastInboundAt: null }).send).toBe(true);
  });

  it('stays quiet while the app is open', () => {
    expect(
      decidePush({
        isCard: true,
        lastInboundAt: null,
        createdAt: '',
        live: true,
        agentFolder: null,
        config,
        now: noon,
      }),
    ).toMatchObject({ send: false });
  });

  it('goes silent in quiet hours except for urgent agents', () => {
    const base = { isCard: false, lastInboundAt: null, createdAt: '', live: false, config, now: night };
    expect(decidePush({ ...base, agentFolder: 'bono' }).level).toBe('passive');
    expect(decidePush({ ...base, agentFolder: 'argus' }).level).toBe('time-sensitive');
    expect(decidePush({ ...base, agentFolder: 'bono', now: noon }).level).toBe('active');
  });

  it('handles quiet hours that wrap midnight and ones that do not', () => {
    expect(inQuietHours(22, [21, 7])).toBe(true);
    expect(inQuietHours(6, [21, 7])).toBe(true);
    expect(inQuietHours(7, [21, 7])).toBe(false);
    expect(inQuietHours(13, [12, 14])).toBe(true);
    expect(inQuietHours(13, null)).toBe(false);
    expect(localHour(new Date('2026-11-13T23:30:00Z'), 'America/Los_Angeles')).toBe(15);
    expect(parseQuietHours(undefined)).toEqual([21, 7]);
    expect(parseQuietHours('off')).toBeNull();
    expect(() => parseQuietHours('nine')).toThrow();
  });

  it('builds a one-line Markdown-free preview', () => {
    expect(previewLine('## Evening brief\n- 3 things')).toBe('Evening brief');
    expect(previewLine('\n**Backup** ran [ok](http://x)')).toBe('Backup ran ok');
    expect(previewLine('x'.repeat(200)).length).toBe(140);
  });

  it('recognises tokens APNs will never accept again', () => {
    expect(isDeadToken({ ok: false, status: 410 })).toBe(true);
    expect(isDeadToken({ ok: false, status: 400, reason: 'BadDeviceToken' })).toBe(true);
    expect(isDeadToken({ ok: false, status: 429, reason: 'TooManyRequests' })).toBe(false);
  });
});

describe('ApnsClient', () => {
  it('signs an ES256 provider token that verifies with the key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apns-test-'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyFile = path.join(dir, 'AuthKey_TEST.p8');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const client = new ApnsClient({ keyFile, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'x.y' });
    const jwt = (client as unknown as { bearer(): string }).bearer();
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toMatchObject({ iss: 'TEAM123456' });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig!, 'base64url'),
    );
    expect(ok).toBe(true);
    // Cached between calls.
    expect((client as unknown as { bearer(): string }).bearer()).toBe(jwt);
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
