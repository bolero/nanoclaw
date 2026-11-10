/**
 * Read-only Dockhand proxy for agents.
 *
 * Dockhand's free plan has no read-only API tokens, so this proxy holds the
 * token and only forwards GET/HEAD for an allowlist of status/log paths.
 * Agents call http://host.docker.internal:<port>/api/... with no credential.
 *
 * Env: DOCKHAND_URL (default https://docker.bhlr.dev), DOCKHAND_TOKEN (required),
 *      PROXY_HOST (default 127.0.0.1), PROXY_PORT (default 8790)
 */
import http from 'http';

const BASE = (process.env.DOCKHAND_URL ?? 'https://docker.bhlr.dev').replace(/\/$/, '');
const TOKEN = process.env.DOCKHAND_TOKEN ?? '';
const HOST = process.env.PROXY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PROXY_PORT ?? 8790);
if (!TOKEN) {
  console.error('DOCKHAND_TOKEN is required');
  process.exit(1);
}

// Allowlist (status, activity, logs). Everything else is refused, including every route that can
// expose secrets: env files, notification/registry/git credentials, auth, users, settings, backups.
const ALLOW = [
  /^\/api\/health(\/.*)?$/,
  /^\/api\/host$/,
  /^\/api\/dashboard\/stats$/,
  /^\/api\/changelog$/,
  /^\/api\/environments$/,
  /^\/api\/environments\/\d+$/,
  /^\/api\/activity(\/.*)?$/,
  /^\/api\/events$/,
  /^\/api\/containers(\/(stats|sizes|check-updates|pending-updates))?$/,
  /^\/api\/containers\/[^/]+(\/(logs|stats|top|changes))?$/,
  /^\/api\/images$/,
  /^\/api\/stacks$/,
  /^\/api\/stacks\/[^/]+$/,
  /^\/api\/git\/stacks$/,
  /^\/api\/git\/stacks\/\d+$/,
];
const DENY = /(\/env(\/|$)|\/env-files|secret|token|credential|password|notification|\/auth|\/users?(\/|$)|settings|backup|registr|webhook|license)/i;

function allowed(pathname: string): boolean {
  return ALLOW.some((r) => r.test(pathname)) && !DENY.test(pathname);
}

http
  .createServer(async (req, res) => {
    const deny = (code: number, msg: string) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(msg + '\n');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'read-only proxy: GET/HEAD only');
    let u: URL;
    try {
      u = new URL(req.url ?? '/', 'http://x');
    } catch {
      return deny(400, 'bad url');
    }
    if (!allowed(u.pathname)) return deny(403, 'path not allowed by read-only proxy');
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30_000);
      const up = await fetch(BASE + u.pathname + u.search, {
        method: req.method,
        headers: { authorization: `Bearer ${TOKEN}`, accept: String(req.headers.accept ?? '*/*') },
        redirect: 'manual',
        signal: ctl.signal,
      });
      clearTimeout(timer);
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/octet-stream' });
      if (req.method === 'HEAD' || !up.body) return res.end();
      const reader = up.body.getReader();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 5_000_000) break; // cap response size
        res.write(value);
      }
      res.end();
    } catch (e) {
      console.error('proxy error', (e as Error).message);
      if (!res.headersSent) deny(502, 'upstream error');
      else res.end();
    }
  })
  .listen(PORT, HOST, () => console.log(`dockhand-ro-proxy listening on ${HOST}:${PORT} -> ${BASE}`));
