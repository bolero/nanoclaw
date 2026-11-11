/**
 * Document helpers for the Google broker: on-device text extraction (the `doctext` helper:
 * PDFKit text layer, Apple Vision OCR fallback) and an explicit, idempotent Paperless upload.
 *
 * Paperless: ~/.config/nanoclaw/paperless.json {base_url, token, user_id} (0600) for a dedicated
 * non-admin identity with documents add/view only. Uploads are keyed by SHA-256; a receipt is
 * reserved before the POST so an interrupted request is never resent automatically.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const DOC_MAX_BYTES = 25 * 1024 * 1024;
export const DOC_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/heic': '.heic',
  'image/tiff': '.tiff',
};

export interface DocText {
  kind: string;
  page: number;
  page_count: number;
  method: string;
  text: string;
  error?: string;
}

export type DocTextFn = (data: Buffer, ext: string, page: number, ocr: boolean) => Promise<DocText>;

/** Run the doctext helper on a private temp copy; the copy is always removed. */
export function doctextRunner(bin = process.env.DOCTEXT_BIN ?? 'doctext'): DocTextFn {
  return async (data, ext, page, ocr) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-doc-'));
    const file = path.join(dir, `doc${ext}`);
    try {
      fs.writeFileSync(file, data, { mode: 0o600 });
      const args = [file, '--page', String(page), ...(ocr ? ['--ocr'] : [])];
      const out = await new Promise<string>((resolve) => {
        execFile(
          bin,
          args,
          { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin' } },
          (_e, stdout) => resolve(String(stdout ?? '')),
        );
      });
      const line = out.trim().split('\n').pop() ?? '';
      try {
        return JSON.parse(line) as DocText;
      } catch {
        return {
          kind: 'unknown',
          page,
          page_count: 0,
          method: 'none',
          text: '',
          error: 'text extraction failed or timed out',
        };
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

interface PaperlessConfig {
  base_url: string;
  token: string;
  user_id: number;
}

interface Receipt {
  state: 'unconfirmed' | 'pending' | 'archived';
  md5: string;
  task?: string;
  document?: number;
  filename: string;
  at: string;
}

export class PaperlessArchive {
  constructor(
    private configFile = path.join(
      process.env.NANOCLAW_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'nanoclaw'),
      'paperless.json',
    ),
    private ledgerFile = process.env.PAPERLESS_LEDGER ??
      path.join(os.homedir(), '.local', 'state', 'nanoclaw', 'paperless-archive.json'),
    private fetchFn: typeof fetch = fetch,
  ) {}

  private config(): PaperlessConfig {
    if (!fs.existsSync(this.configFile)) throw new Error('Paperless is not configured yet (owner setup pending)');
    const c = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as PaperlessConfig;
    if (!/^https:\/\/[a-z0-9.-]+$/.test(c.base_url) || !c.token || typeof c.user_id !== 'number') {
      throw new Error('Paperless config is invalid');
    }
    return c;
  }

  private ledger(): Record<string, Receipt> {
    try {
      return JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8')) as Record<string, Receipt>;
    } catch {
      return {};
    }
  }

  private save(l: Record<string, Receipt>): void {
    fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.ledgerFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 });
    fs.renameSync(tmp, this.ledgerFile);
  }

  private async api(c: PaperlessConfig, p: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchFn(c.base_url + p, {
      ...init,
      redirect: 'error',
      headers: { authorization: `Token ${c.token}`, accept: 'application/json; version=9', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Paperless error ${res.status}`);
    return res.json();
  }

  private async findByMd5(c: PaperlessConfig, md5: string): Promise<number | null> {
    const q = new URLSearchParams({ checksum__iexact: md5, page_size: '5', fields: 'id,owner' });
    const r = (await this.api(c, `/api/documents/?${q}`)) as { results?: { id: number; owner: number | null }[] };
    const hit = (r.results ?? []).find((d) => typeof d.id === 'number' && d.owner === c.user_id);
    return hit ? hit.id : null;
  }

  private view(c: PaperlessConfig, receipt: string, r: Receipt): string {
    if (r.state === 'archived' && r.document) {
      return `Archived "${r.filename}" in Paperless: ${c.base_url}/documents/${r.document}/details (receipt ${receipt.slice(0, 12)})`;
    }
    return `Upload of "${r.filename}" is ${r.state}; Paperless is still processing it. Check later with archive_status receipt ${receipt.slice(0, 12)}. Do not upload it again.`;
  }

  async status(receiptPrefix: string): Promise<string> {
    if (!/^[a-f0-9]{8,64}$/.test(receiptPrefix)) throw new Error('receipt is invalid');
    const c = this.config();
    const l = this.ledger();
    const key = Object.keys(l).find((k) => k.startsWith(receiptPrefix));
    if (!key) throw new Error('receipt not found');
    const r = l[key];
    if (r.state !== 'archived') {
      const id = await this.findByMd5(c, r.md5);
      if (id) {
        r.state = 'archived';
        r.document = id;
        this.save(l);
      }
    }
    return this.view(c, key, r);
  }

  async archive(data: Buffer, filename: string, mime: string, title?: string): Promise<string> {
    const c = this.config();
    if (!DOC_TYPES[mime]) throw new Error('only PDFs and images can be archived');
    if (data.length === 0 || data.length > DOC_MAX_BYTES) throw new Error('file is empty or larger than 25 MB');
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    const name = filename.replace(/[^A-Za-z0-9_. -]/g, '_').slice(0, 150) || `email-document${DOC_TYPES[mime]}`;
    const l = this.ledger();
    if (l[digest]) return this.status(digest);
    const existing = await this.findByMd5(c, md5);
    if (existing) {
      l[digest] = { state: 'archived', md5, document: existing, filename: name, at: new Date().toISOString() };
      this.save(l);
      return this.view(c, digest, l[digest]);
    }
    // Reserve before POST: a lost reply must never cause a second upload.
    l[digest] = { state: 'unconfirmed', md5, filename: name, at: new Date().toISOString() };
    this.save(l);
    const form = new FormData();
    form.append('document', new Blob([new Uint8Array(data)], { type: mime }), name);
    if (title) form.append('title', title.slice(0, 128));
    try {
      const task = await this.api(c, '/api/documents/post_document/', { method: 'POST', body: form });
      if (typeof task !== 'string' || !/^[a-f0-9-]{36}$/.test(task)) throw new Error('unexpected reply');
      l[digest] = { ...l[digest], state: 'pending', task };
      this.save(l);
    } catch {
      return `Upload outcome for "${name}" is unknown. Check with archive_status receipt ${digest.slice(0, 12)}; do not upload again.`;
    }
    return this.status(digest);
  }
}
