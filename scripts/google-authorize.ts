/**
 * Google consent for the broker. Owner-run; never prints tokens.
 *
 *   pnpm exec tsx scripts/google-authorize.ts <account-id>
 *       Loopback OAuth (PKCE) with the existing Desktop client. Scopes come from home.yaml.
 *       Opens the browser; checks the signed-in mailbox matches home.yaml and every scope
 *       was granted; writes ~/.config/nanoclaw/google/<account>.json (0600).
 *
 *   pnpm exec tsx scripts/google-authorize.ts --import-aegis <account-id>
 *       Seeds a grant from the existing Aegis Gmail credential (same client, same refresh
 *       token) after checking its account and proving the refresh token still works.
 *
 *   pnpm exec tsx scripts/google-authorize.ts --start <account-id>
 *   pnpm exec tsx scripts/google-authorize.ts --finish <account-id> '<127.0.0.1:8099/callback?... address>'
 *       Same consent from a phone or any other device: --start prints the link; after approving,
 *       the browser lands on an address it cannot open; paste it into --finish here.
 *
 *   pnpm exec tsx scripts/google-authorize.ts --status
 *
 * Client file: $GOOGLE_CLIENT_FILE or ~/.config/aegis-gmail/credentials.json (referenced, not copied).
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { type Grant, GRANTS_DIR, grantPath, readClient, SCOPE, writeGrant } from './google-broker.js';
import { loadHomeConfig } from './home-config.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AEGIS = path.join(os.homedir(), '.config', 'aegis-gmail', 'credentials.json');
const CLIENT_FILE = process.env.GOOGLE_CLIENT_FILE ?? AEGIS;

function account(id: string) {
  const a = loadHomeConfig().google_accounts.find((x) => x.id === id);
  if (!a) throw new Error(`no google account "${id}" in home.yaml`);
  return a;
}

async function refresh(clientFile: string, refreshToken: string): Promise<{ access_token: string; scope?: string }> {
  const c = readClient(clientFile);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`refresh failed: ${body.error ?? res.status}`);
  return { access_token: body.access_token, scope: body.scope };
}

async function mailboxAddress(accessToken: string): Promise<string> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`could not read the Gmail profile (${res.status})`);
  return String(((await res.json()) as { emailAddress?: string }).emailAddress ?? '').toLowerCase();
}

function missingScopes(wanted: string[], granted: string | undefined): string[] {
  const have = new Set((granted ?? '').split(/\s+/).filter(Boolean));
  return wanted.map(SCOPE).filter((s) => !have.has(s));
}

async function importAegis(id: string): Promise<void> {
  const acct = account(id);
  const raw = JSON.parse(fs.readFileSync(AEGIS, 'utf8')) as {
    refresh_token?: string;
    expected_account?: string;
    granted_scopes?: string[];
  };
  if (!raw.refresh_token) throw new Error('Aegis credential has no refresh token');
  if (String(raw.expected_account).toLowerCase() !== acct.address.toLowerCase()) {
    throw new Error(`Aegis credential is for a different account than home.yaml "${id}"`);
  }
  const { access_token, scope } = await refresh(AEGIS, raw.refresh_token);
  if ((await mailboxAddress(access_token)) !== acct.address.toLowerCase())
    throw new Error('signed-in mailbox mismatch');
  const scopes = (scope ?? (raw.granted_scopes ?? []).join(' ')).split(/\s+/).filter(Boolean);
  const file = writeGrant({
    version: 1,
    account: id,
    address: acct.address,
    refresh_token: raw.refresh_token,
    scopes,
    client_file: AEGIS,
  });
  const missing = missingScopes(acct.scopes, scopes.join(' '));
  console.log(`seeded ${file} from Aegis (${scopes.length} scope(s))`);
  if (missing.length)
    console.log(`still missing (needs consent): ${missing.map((s) => s.replace(SCOPE(''), '')).join(', ')}`);
}

async function consent(id: string): Promise<void> {
  const acct = account(id);
  const client = readClient(CLIENT_FILE);
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const scopes = acct.scopes.map(SCOPE);

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
      res.end(ok ? 'Google consent received. You can close this tab.' : 'Consent failed or was cancelled.');
      server.close();
      if (ok) resolve({ code: url.searchParams.get('code')!, redirect });
      else reject(new Error(`consent failed: ${url.searchParams.get('error') ?? 'state mismatch'}`));
    });
    let redirect = '';
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      redirect = `http://127.0.0.1:${port}/callback`;
      const url = `${AUTH_URL}?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        login_hint: acct.address,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`;
      console.log(`Sign in as ${acct.address} and approve. If the browser did not open:\n${url}`);
      execFile('open', [url], () => {});
    });
    setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for consent (5 min)'));
    }, 300_000).unref();
  });

  await exchangeAndSave(id, code.code, verifier, code.redirect);
}

async function exchangeAndSave(id: string, authCode: string, verifier: string, redirect: string): Promise<void> {
  const acct = account(id);
  const client = readClient(CLIENT_FILE);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code: authCode,
      code_verifier: verifier,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !tok.access_token || !tok.refresh_token)
    throw new Error(`token exchange failed: ${tok.error ?? res.status}`);
  const missing = missingScopes(acct.scopes, tok.scope);
  if (missing.length)
    throw new Error(`not all scopes were granted (missing ${missing.join(', ')}); run again and tick every box`);
  if ((await mailboxAddress(tok.access_token)) !== acct.address.toLowerCase()) {
    throw new Error(`signed in as a different account than ${acct.address}; nothing saved`);
  }
  const grant: Grant = {
    version: 1,
    account: id,
    address: acct.address,
    refresh_token: tok.refresh_token,
    scopes: (tok.scope ?? '').split(/\s+/).filter(Boolean),
    client_file: CLIENT_FILE,
  };
  console.log(
    `saved ${writeGrant(grant)}; restart the broker: launchctl kickstart -k gui/$(id -u)/com.nanoclaw-google-broker`,
  );
}

// ---- phone-friendly two-step consent ------------------------------------------------------
// --start prints a link that can be opened on any device; Google then redirects to a loopback
// address that the phone cannot open. Paste that address into --finish on this machine, which
// holds the PKCE verifier (pending file, 0600, valid 15 minutes).

const PENDING_TTL_MS = 15 * 60_000;
const pendingPath = (id: string): string => path.join(GRANTS_DIR, `pending-${id}.json`);

function start(id: string): void {
  const acct = account(id);
  const client = readClient(CLIENT_FILE);
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const redirect = 'http://127.0.0.1:8099/callback';
  fs.mkdirSync(GRANTS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingPath(id), JSON.stringify({ verifier, state, redirect, created: Date.now() }), {
    mode: 0o600,
  });
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: acct.scopes.map(SCOPE).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    login_hint: acct.address,
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })}`;
  console.log(
    `Open on any device, sign in as ${acct.address}, approve, then copy the address of the page that fails to load (127.0.0.1:8099/callback?...) and run:\n  --finish ${id} '<that address>'\n\n${url}`,
  );
}

async function finish(id: string, callback: string): Promise<void> {
  const file = pendingPath(id);
  if (!fs.existsSync(file)) throw new Error(`no pending sign-in for ${id}; run --start ${id} first`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    verifier: string;
    state: string;
    redirect: string;
    created: number;
  };
  if (Date.now() - p.created > PENDING_TTL_MS) {
    fs.rmSync(file, { force: true });
    throw new Error('the sign-in link expired (15 min); run --start again');
  }
  const { code: authCode, state } = parseCallback(callback);
  if (state !== p.state) throw new Error('this address belongs to a different sign-in (state mismatch)');
  // Keep the pending sign-in until the exchange succeeds, so a bad paste can be retried.
  await exchangeAndSave(id, authCode, p.verifier, p.redirect);
  fs.rmSync(file, { force: true });
}

/** Accepts the callback address with or without a scheme ("127.0.0.1:8099/callback?..."). */
export function parseCallback(raw: string): { code: string; state: string } {
  const text = raw.trim();
  const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  const code = url.searchParams.get('code');
  if (!code) throw new Error(`consent failed: ${url.searchParams.get('error') ?? 'no code in the address'}`);
  return { code, state: url.searchParams.get('state') ?? '' };
}

function status(): void {
  for (const a of loadHomeConfig().google_accounts) {
    const file = grantPath(a.id);
    if (!fs.existsSync(file)) {
      console.log(`${a.id}: no grant`);
      continue;
    }
    const g = JSON.parse(fs.readFileSync(file, 'utf8')) as Grant;
    const missing = missingScopes(a.scopes, g.scopes.join(' '));
    console.log(
      `${a.id}: grant present${missing.length ? `, missing ${missing.map((s) => s.replace(SCOPE(''), '')).join(', ')}` : ', all scopes'}`,
    );
  }
  console.log(`(grants in ${GRANTS_DIR})`);
}

const [first, second] = process.argv.slice(2);
(async () => {
  if (first === '--status') status();
  else if (first === '--import-aegis' && second) await importAegis(second);
  else if (first === '--start' && second) start(second);
  else if (first === '--finish' && second && process.argv[4]) await finish(second, process.argv[4]);
  else if (first && !first.startsWith('-')) await consent(first);
  else {
    console.error('usage: google-authorize.ts <account> | --import-aegis <account> | --status');
    process.exit(2);
  }
})().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
