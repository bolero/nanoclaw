import fs from 'fs';
import type http from 'http';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { readClient } from './google-broker.js';
import { createConsentHandler, readWebClient } from './google-phone-auth.js';

const ORIGIN = 'https://vm.example.ts.net';

function fakeRes() {
  const r = { status: 0, headers: {} as Record<string, string>, body: '', headersSent: false };
  const res = {
    setHeader: (k: string, v: string) => {
      r.headers[k.toLowerCase()] = v;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      r.status = status;
      Object.assign(r.headers, headers ?? {});
      r.headersSent = true;
      return res;
    },
    end(body?: string) {
      r.body = body ?? '';
    },
  };
  return { res: res as unknown as http.ServerResponse, r };
}

const req = (url: string, method = 'GET') => ({ url, method }) as http.IncomingMessage;

function setup(complete: (code: string) => Promise<void> = async () => {}) {
  const statuses: string[] = [];
  let finished = 0;
  const c = createConsentHandler({
    publicUrl: ORIGIN,
    clientId: 'cid',
    address: 'a@example.com',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    complete: (code) => complete(code),
    update: (s) => statuses.push(s),
    finished: () => finished++,
  });
  const start = new URL(c.url).pathname;
  return { c, start, statuses, finished: () => finished };
}

async function hit(c: ReturnType<typeof setup>['c'], url: string, method = 'GET') {
  const { res, r } = fakeRes();
  await c.handler(req(url, method), res);
  return r;
}

describe('google phone consent', () => {
  it('redirects only the secret start path to Google with PKCE and state', async () => {
    const { c, start } = setup();
    expect(start).toMatch(/^\/start\/[\w-]{20,}$/);
    const r = await hit(c, start);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.host).toBe('accounts.google.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect((await hit(c, '/start/guess')).status).toBe(404);
    expect((await hit(c, start, 'POST')).status).toBe(405);
  });

  it('rejects a wrong state and accepts the right one exactly once', async () => {
    const codes: string[] = [];
    const s = setup(async (code) => {
      codes.push(code);
    });
    const state = new URL((await hit(s.c, s.start)).headers.location).searchParams.get('state')!;
    expect((await hit(s.c, '/callback?state=nope&code=x')).status).toBe(400);
    const ok = await hit(s.c, `/callback?state=${state}&code=abc`);
    expect(ok.status).toBe(200);
    expect(codes).toEqual(['abc']);
    expect(s.statuses).toEqual(['exchanging', 'complete']);
    expect((await hit(s.c, `/callback?state=${state}&code=again`)).status).toBe(409);
    expect((await hit(s.c, s.start)).status).toBe(404); // start link is dead after use
    expect(s.finished()).toBe(1);
  });

  it('reports cancel and exchange failure without leaking details', async () => {
    const cancel = setup();
    const st1 = new URL((await hit(cancel.c, cancel.start)).headers.location).searchParams.get('state')!;
    expect((await hit(cancel.c, `/callback?state=${st1}&error=access_denied`)).status).toBe(400);
    expect(cancel.statuses).toEqual(['cancelled']);

    const fail = setup(async () => {
      throw new Error('The signed-in Google account does not match. Existing grants were preserved.');
    });
    const st2 = new URL((await hit(fail.c, fail.start)).headers.location).searchParams.get('state')!;
    const r = await hit(fail.c, `/callback?state=${st2}&code=x`);
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/does not match/);
    expect(fail.statuses).toEqual(['exchanging', 'failed']);
  });

  it('requires a private Web client file with the exact redirect', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpa-'));
    const file = path.join(dir, 'web.json');
    const redirect = `${ORIGIN}/callback`;
    expect(() => readWebClient(file, redirect)).toThrow(/Create a Google Web application/);
    fs.writeFileSync(file, JSON.stringify({ web: { client_id: 'i', client_secret: 's', redirect_uris: [redirect] } }), {
      mode: 0o644,
    });
    expect(() => readWebClient(file, redirect)).toThrow(/mode 600/);
    fs.chmodSync(file, 0o600);
    expect(readWebClient(file, redirect).client_id).toBe('i');
    expect(() => readWebClient(file, `${ORIGIN}/other`)).toThrow(/exact registered redirect/);
    // The broker can refresh tokens issued to a Web client as well as a Desktop one.
    expect(readClient(file).client_id).toBe('i');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
