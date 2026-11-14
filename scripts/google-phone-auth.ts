/** Host-only Google Web OAuth consent behind a temporary Tailscale Serve route. */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Grant, SCOPE, writeGrant } from './google-broker.js';
import { loadHomeConfig } from './home-config.js';

export interface WebClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

export function readWebClient(file: string, redirect: string): WebClient {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Create a Google Web application OAuth client with redirect ${redirect}, then save its downloaded JSON to ${file} (mode 600).`,
    );
  }
  const mode = fs.statSync(file).mode;
  if (mode & 0o077) throw new Error('Web OAuth client file must have mode 600.');
  let raw: { web?: Partial<WebClient> };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { web?: Partial<WebClient> };
  } catch {
    throw new Error('Web OAuth client file could not be parsed. Download a fresh JSON file from Google Cloud.');
  }
  const client = raw.web;
  if (
    !client ||
    typeof client.client_id !== 'string' ||
    typeof client.client_secret !== 'string' ||
    !Array.isArray(client.redirect_uris) ||
    !client.redirect_uris.includes(redirect)
  ) {
    throw new Error(`A Web application client with the exact registered redirect ${redirect} is required.`);
  }
  return client as WebClient;
}

interface ConsentOptions {
  publicUrl: string;
  clientId: string;
  address: string;
  scopes: string[];
  complete: (code: string, verifier: string, redirect: string) => Promise<void>;
  update: (status: string) => void;
  finished: () => void;
}

export function createConsentHandler(options: ConsentOptions) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const startPath = `/start/${crypto.randomBytes(24).toString('base64url')}`;
  const redirect = `${options.publicUrl}/callback`;
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: options.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    login_hint: options.address,
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  let phase = 'waiting';

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    if (req.method !== 'GET') {
      res.writeHead(405).end('Use GET.');
      return;
    }
    const url = new URL(req.url ?? '/', options.publicUrl);
    if (url.pathname === startPath && phase === 'waiting') {
      res.writeHead(302, { location: authorization.toString() }).end();
      return;
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404).end('Unknown or expired consent link.');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid consent state. Use the original sign-in link.');
      return;
    }
    if (phase !== 'waiting') {
      res.writeHead(409).end('Consent was already submitted.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.has('error')) {
      phase = 'cancelled';
      options.update(phase);
      res.writeHead(400).end('Google consent was cancelled. Ask for a new sign-in link.');
      options.finished();
      return;
    }
    phase = 'exchanging';
    options.update(phase);
    try {
      await options.complete(code, verifier, redirect);
      phase = 'complete';
      options.update(phase);
      res.writeHead(200).end('Google connected. You can close this tab and return to Bono.');
    } catch (error) {
      phase = 'failed';
      options.update(phase);
      // A controlled message from the exchange checks, without provider response bodies.
      const message = error instanceof Error ? error.message : 'Consent failed.';
      res.writeHead(400).end(message);
    }
    options.finished();
  };
  return { handler, url: `${options.publicUrl}${startPath}` };
}

async function main(): Promise<void> {
  const id = process.argv[2];
  const account = loadHomeConfig().google_accounts.find((entry) => entry.id === id);
  if (!account) throw new Error('Choose a configured Google account id.');
  const publicUrl = new URL(process.env.GOOGLE_AUTH_PUBLIC_URL ?? '');
  if (
    publicUrl.protocol !== 'https:' ||
    !publicUrl.hostname.endsWith('.ts.net') ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== '/'
  ) {
    throw new Error('GOOGLE_AUTH_PUBLIC_URL must be a tailnet HTTPS origin.');
  }
  const origin = publicUrl.origin;
  const clientFile =
    process.env.GOOGLE_WEB_CLIENT_FILE ?? path.join(os.homedir(), '.config/nanoclaw/google-web-client.json');
  const client = readWebClient(clientFile, `${origin}/callback`);
  if (!account.scopes.includes('gmail.readonly')) {
    throw new Error(`Account "${id}" needs gmail.readonly: the signed-in mailbox is verified through Gmail.`);
  }
  const scopes = account.scopes.map(SCOPE);
  const stateFile = path.join(os.homedir(), '.local/state/nanoclaw/google-phone-auth.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  let link = '';
  const update = (status: string) => {
    const temporary = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ account: id, status, url: link, updatedAt: new Date().toISOString() }) + '\n',
      { mode: 0o600 },
    );
    fs.renameSync(temporary, stateFile);
  };
  let server: http.Server;
  const complete = async (code: string, verifier: string, redirect: string) => {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      }),
    });
    const token = (await response.json()) as { access_token?: string; refresh_token?: string; scope?: string };
    if (!response.ok || !token.access_token || !token.refresh_token)
      throw new Error('Google token exchange failed. Ask for a new link.');
    const granted = (token.scope ?? '').split(/\s+/).filter(Boolean);
    if (scopes.some((scope) => !granted.includes(scope)))
      throw new Error(
        'Some required permissions were declined. Ask for a new link and grant the requested permissions.',
      );
    const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!profile.ok) throw new Error('Google mailbox verification failed. Existing grants were preserved.');
    const data = (await profile.json()) as { emailAddress?: string };
    if (data.emailAddress?.toLowerCase() !== account.address.toLowerCase())
      throw new Error('The signed-in Google account does not match. Existing grants were preserved.');
    const grant: Grant = {
      version: 1,
      account: account.id,
      address: account.address,
      refresh_token: token.refresh_token,
      scopes: granted,
      client_file: clientFile,
    };
    writeGrant(grant);
    await new Promise<void>((resolve, reject) => {
      execFile('systemctl', ['--user', 'restart', 'nanoclaw-google-broker'], { timeout: 30_000 }, (error) => {
        if (error) reject(new Error('Google grant saved. The broker needs an operator restart.'));
        else resolve();
      });
    });
  };
  const consent = createConsentHandler({
    publicUrl: origin,
    clientId: client.client_id,
    address: account.address,
    scopes,
    complete,
    update,
    finished: () => {
      setTimeout(() => server.close(), 2000);
    },
  });
  link = consent.url;
  server = http.createServer((req, res) => {
    void consent.handler(req, res).catch(() => {
      update('failed');
      if (!res.headersSent) res.writeHead(500);
      res.end('Consent failed. Ask for a new sign-in link.');
      server.close();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(8765, '127.0.0.1', resolve);
  });
  update('waiting');
  console.log('Phone consent ready. Retrieve the link through the restricted VM helper.');
  const expiry = setTimeout(() => {
    update('expired');
    server.close();
  }, 900_000);
  process.once('SIGTERM', () => {
    update('expired');
    server.close();
  });
  await new Promise<void>((resolve) => server.once('close', resolve));
  clearTimeout(expiry);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Consent failed.');
    process.exitCode = 1;
  });
}
