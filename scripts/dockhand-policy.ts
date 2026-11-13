/**
 * Request policy for the read-only Dockhand proxy: an exact allowlist of the GET routes
 * argus uses (see groups/argus instructions), each with its own allowed query params.
 * Anything not listed is refused — there is no deny-regex fallback to get wrong.
 */

type QueryRule = RegExp;
interface Route {
  path: RegExp;
  query: Record<string, QueryRule>;
}

const INT = /^[1-9][0-9]{0,6}$/;
const SMALL_INT = /^[1-9][0-9]{0,3}$/;
const BOOL = /^(true|false)$/;
// Container ids (hex) or names; no dots-only segments, no slashes, no encoding.
const CONTAINER = /[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/;

// Dockhand reads `env`; `environmentId` is kept for older callers (Dockhand ignores it).
const ENV = { env: INT, environmentId: INT };
const route = (p: string, query: Record<string, QueryRule> = {}): Route => ({
  path: new RegExp(`^${p}$`),
  query,
});

export const ROUTES: Route[] = [
  route('/api/health'),
  route('/api/environments'),
  route('/api/environments/[1-9][0-9]{0,6}'),
  route('/api/containers', { ...ENV, all: BOOL }),
  route(`/api/containers/${CONTAINER.source}/logs`, { ...ENV, tail: SMALL_INT }),
  route(`/api/containers/${CONTAINER.source}/stats`, ENV),
  route('/api/stacks', ENV),
  route('/api/git/stacks'),
  route('/api/git/stacks/[1-9][0-9]{0,6}'),
  route('/api/activity', { ...ENV, limit: SMALL_INT }),
  // GET only returns Dockhand's stored update-check results; POST (runs a check) and
  // DELETE (clears results) are refused by the GET/HEAD rule below.
  route('/api/containers/pending-updates', { env: INT }),
  route('/api/containers/check-updates', { env: INT }),
];

export type Verdict = { ok: true } | { ok: false; code: number; reason: string };

export function checkRequest(method: string | undefined, rawUrl: string | undefined): Verdict {
  if (method !== 'GET' && method !== 'HEAD') return { ok: false, code: 405, reason: 'read-only proxy: GET/HEAD only' };
  const raw = rawUrl ?? '/';
  // No encoding, traversal, doubled slashes or fragments: what we match is what upstream sees.
  if (/%|\/\/|\/\.\.?(\/|$|\?)|#|\\/.test(raw)) return { ok: false, code: 400, reason: 'bad url' };
  let u: URL;
  try {
    u = new URL(raw, 'http://x');
  } catch {
    return { ok: false, code: 400, reason: 'bad url' };
  }
  const r = ROUTES.find((x) => x.path.test(u.pathname));
  if (!r) return { ok: false, code: 403, reason: 'path not allowed by read-only proxy' };
  const seen = new Set<string>();
  for (const [k, v] of u.searchParams) {
    const rule = r.query[k];
    if (!rule || !rule.test(v) || seen.has(k)) return { ok: false, code: 403, reason: `query "${k}" not allowed` };
    seen.add(k);
  }
  return { ok: true };
}
