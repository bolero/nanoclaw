/**
 * Deterministic mail attachment archiving: no model is involved anywhere.
 *
 * For each `mail_archive` rule in home.yaml, search the account's Gmail for mail from the exact
 * sender with the exact attachment filename, check that Gmail itself verified the sender
 * (DMARC, or aligned DKIM), and upload the attachment to Paperless through the same idempotent
 * uploader the broker uses. Optionally post one line to a person's Home chat in the app
 * (`ncl app notify`) when something was saved or something went wrong.
 *
 *   pnpm exec tsx scripts/mail-autoarchive.ts            # run all rules once
 *   pnpm exec tsx scripts/mail-autoarchive.ts --dry-run  # list what would be saved, change nothing
 *
 * State (processed message ids, last error per rule): ~/.local/state/nanoclaw/mail-autoarchive.json
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { PaperlessArchive } from './broker-docs.js';
import { GoogleTokens } from './google-broker.js';
import { checkForwarder, type GmailMessage, type GmailPart } from './google-mail.js';
import { type MailArchiveRule, loadHomeConfig } from './home-config.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_PER_RUN = 200;

export interface Found {
  messageId: string;
  date: Date;
  filename: string;
  attachmentId: string;
  mime: string;
  verified: boolean;
  reason: string;
}

export interface Deps {
  /** Messages matching the rule (newest first), with the matching attachment located. */
  find(rule: MailArchiveRule): Promise<Found[]>;
  download(rule: MailArchiveRule, f: Found): Promise<Buffer>;
  archive(data: Buffer, filename: string, mime: string, title: string, share: boolean): Promise<string>;
  notify(handle: string, text: string): Promise<void>;
  timezone: string;
}

interface RuleState {
  done: Record<string, string>;
  /** Messages we told the person about as failures, so the hourly retry does not repeat the notice. */
  warned: Record<string, string>;
  lastError?: string;
}
type State = Record<string, RuleState>;

export const STATE_FILE =
  process.env.MAIL_AUTOARCHIVE_STATE ?? path.join(os.homedir(), '.local', 'state', 'nanoclaw', 'mail-autoarchive.json');

export function readState(file = STATE_FILE): State {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as State;
  } catch {
    return {};
  }
}

export function writeState(state: State, file = STATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function shortDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

/** Depth-first search for the attachment part with exactly this filename (case-insensitive). */
export function findAttachment(part: GmailPart | undefined, filename: string): GmailPart | null {
  if (!part) return null;
  const p = part as GmailPart & { filename?: string; body?: { attachmentId?: string } };
  if (p.filename && p.filename.toLowerCase() === filename.toLowerCase() && p.body?.attachmentId) return part;
  for (const child of (part as { parts?: GmailPart[] }).parts ?? []) {
    const hit = findAttachment(child, filename);
    if (hit) return hit;
  }
  return null;
}

export function gmailQuery(rule: MailArchiveRule): string {
  return `from:${rule.from} has:attachment filename:"${rule.attachment}"`;
}

/** Run every rule once. Returns the lines that were (or would be) posted. */
export async function runRules(
  rules: MailArchiveRule[],
  deps: Deps,
  state: State,
  opts: { dryRun?: boolean } = {},
): Promise<string[]> {
  const posted: string[] = [];
  const say = async (rule: MailArchiveRule, text: string): Promise<void> => {
    posted.push(`[${rule.id}] ${text}`);
    if (!opts.dryRun && rule.notify) {
      try {
        await deps.notify(rule.notify, text);
      } catch (e) {
        console.error(`[${rule.id}] notify failed: ${(e as Error).message}`);
      }
    }
  };

  for (const rule of rules) {
    const st: RuleState = (state[rule.id] ??= { done: {}, warned: {} });
    const label = rule.title.toLowerCase();
    let found: Found[];
    try {
      found = await deps.find(rule);
    } catch (e) {
      const msg = (e as Error).message;
      if (st.lastError !== msg) await say(rule, `Couldn't check mail for ${label}s: ${msg}. I'll keep retrying.`);
      st.lastError = msg;
      continue;
    }
    if (st.lastError) {
      await say(rule, `Mail checks for ${label}s work again.`);
      delete st.lastError;
    }

    const todo = found.filter((f) => !st.done[f.messageId]).slice(0, MAX_PER_RUN);
    const saved: Date[] = [];
    for (const f of todo.reverse()) {
      const day = shortDate(f.date, deps.timezone);
      if (!f.verified) {
        if (!st.warned[f.messageId]) {
          await say(
            rule,
            `Ignored a ${label} email from ${day}: Gmail could not verify it came from ${rule.from} (${f.reason}). Nothing was saved.`,
          );
          st.warned[f.messageId] = new Date().toISOString();
        }
        continue;
      }
      if (opts.dryRun) {
        posted.push(`[${rule.id}] would save ${rule.title} ${localDate(f.date, deps.timezone)} (${f.filename})`);
        continue;
      }
      try {
        const data = await deps.download(rule, f);
        const title = `${rule.title} ${localDate(f.date, deps.timezone)}`;
        const result = await deps.archive(data, f.filename, f.mime, title, rule.share === true);
        if (/outcome .* is unknown/i.test(result)) throw new Error('Paperless did not confirm the upload');
        st.done[f.messageId] = new Date().toISOString();
        delete st.warned[f.messageId];
        saved.push(f.date);
      } catch (e) {
        if (!st.warned[f.messageId]) {
          await say(rule, `Couldn't save the ${label} from ${day}: ${(e as Error).message}. I'll retry every hour.`);
          st.warned[f.messageId] = new Date().toISOString();
        }
      }
    }

    if (saved.length === 1) {
      await say(rule, `Saved ${label} for ${shortDate(saved[0], deps.timezone)} to Paperless.`);
    } else if (saved.length > 1) {
      const first = shortDate(saved[0], deps.timezone);
      const last = shortDate(saved[saved.length - 1], deps.timezone);
      await say(rule, `Saved ${saved.length} ${label}s to Paperless (${first} – ${last}).`);
    }
  }
  return posted;
}

// ---------- real dependencies ----------

async function gmail(token: string, p: string): Promise<unknown> {
  const res = await fetch(`${GMAIL}${p}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error' });
  if (!res.ok) throw new Error(`Gmail error ${res.status}`);
  return res.json();
}

function liveDeps(tokens: GoogleTokens, archiver: PaperlessArchive, nclBin: string, timezone: string): Deps {
  const token = async (rule: MailArchiveRule): Promise<string> => {
    try {
      return await tokens.token(rule.account, 'gmail.readonly');
    } catch (e) {
      const m = (e as Error).message;
      throw new Error(/needs_consent/.test(m) ? `Google sign-in for "${rule.account}" is needed again` : m);
    }
  };
  return {
    timezone,
    async find(rule) {
      const t = await token(rule);
      const ids: string[] = [];
      let page: string | undefined;
      do {
        const q = new URLSearchParams({ q: gmailQuery(rule), maxResults: '100', ...(page ? { pageToken: page } : {}) });
        const r = (await gmail(t, `/messages?${q}`)) as { messages?: { id: string }[]; nextPageToken?: string };
        for (const m of r.messages ?? []) ids.push(m.id);
        page = r.nextPageToken;
      } while (page && ids.length < 1000);
      const out: Found[] = [];
      for (const id of ids) {
        const msg = (await gmail(t, `/messages/${id}?format=full`)) as GmailMessage & { internalDate?: string };
        const part = findAttachment(msg.payload, rule.attachment) as
          | (GmailPart & { filename: string; mimeType?: string; body: { attachmentId: string } })
          | null;
        if (!part) continue; // Gmail's filename: search is fuzzy; we require an exact match
        const verdict = checkForwarder(msg, [rule.from]);
        out.push({
          messageId: id,
          date: new Date(Number(msg.internalDate ?? Date.now())),
          filename: part.filename,
          attachmentId: part.body.attachmentId,
          mime:
            (part.mimeType ?? '').toLowerCase() === 'application/octet-stream'
              ? 'application/pdf'
              : (part.mimeType ?? 'application/pdf').toLowerCase(),
          verified: verdict.ok,
          reason: verdict.reason,
        });
      }
      return out;
    },
    async download(rule, f) {
      const t = await token(rule);
      const r = (await gmail(t, `/messages/${f.messageId}/attachments/${f.attachmentId}`)) as { data?: string };
      if (!r.data) throw new Error('Gmail returned an empty attachment');
      return Buffer.from(r.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    },
    archive: (data, filename, mime, title, share) => archiver.archive(data, filename, mime, title, share),
    async notify(handle, text) {
      await promisify(execFile)(
        nclBin,
        ['app', 'notify', '--user', handle, '--text', text, '--sender', 'Mail archive'],
        {
          timeout: 30_000,
        },
      );
    },
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadHomeConfig();
  const rules = cfg.mail_archive ?? [];
  if (rules.length === 0) {
    console.log('no mail_archive rules in home.yaml');
    return;
  }
  const tokens = new GoogleTokens(() => cfg.google_accounts.map((a) => a.id));
  const timezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ncl = process.env.NCL_BIN ?? path.join(process.cwd(), 'bin', 'ncl');
  const state = readState();
  const lines = await runRules(rules, liveDeps(tokens, new PaperlessArchive(), ncl, timezone), state, { dryRun });
  if (!dryRun) writeState(state);
  for (const l of lines) console.log(l);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
