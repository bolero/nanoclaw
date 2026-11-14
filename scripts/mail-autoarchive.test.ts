import { describe, expect, it } from 'vitest';

import type { MailArchiveRule } from './home-config.js';
import { parseHomeConfig } from './home-config.js';
import { type Deps, type Found, findAttachment, gmailQuery, localDate, runRules } from './mail-autoarchive.js';

const rule: MailArchiveRule = {
  id: 'payslips',
  account: 'personal',
  from: 'payroll@example.com',
  attachment: 'Payslip.pdf',
  title: 'Payslip',
  notify: 'alex',
};

function found(id: string, day: string, verified = true): Found {
  return {
    messageId: id,
    date: new Date(`${day}T18:00:00Z`),
    filename: 'Payslip.pdf',
    attachmentId: `att-${id}`,
    mime: 'application/pdf',
    verified,
    reason: verified ? 'dmarc pass' : 'dmarc fail',
  };
}

function deps(list: Found[] | Error, over: Partial<Deps> = {}) {
  const uploads: { title: string; share: boolean }[] = [];
  const notes: string[] = [];
  const d: Deps = {
    timezone: 'America/Los_Angeles',
    find: async () => {
      if (list instanceof Error) throw list;
      return list;
    },
    download: async () => Buffer.from('%PDF'),
    archive: async (_d, _f, _m, title, share) => {
      uploads.push({ title, share });
      return 'Archived "Payslip.pdf" in Paperless';
    },
    notify: async (_h, text) => {
      notes.push(text);
    },
    ...over,
  };
  return { d, uploads, notes };
}

describe('mail-autoarchive', () => {
  it('saves new verified attachments once, oldest first, and posts one line', async () => {
    const state = {};
    const { d, uploads, notes } = deps([found('m2', '2026-11-15'), found('m1', '2026-10-31')]);
    await runRules([rule], d, state);
    expect(uploads.map((u) => u.title)).toEqual(['Payslip 2026-10-31', 'Payslip 2026-11-15']);
    expect(uploads.every((u) => u.share === false)).toBe(true);
    expect(notes).toEqual(['Saved 2 payslips to Paperless (Oct 31, 2026 – Nov 15, 2026).']);

    const again = deps([found('m2', '2026-11-15'), found('m1', '2026-10-31')]);
    await runRules([rule], again.d, state);
    expect(again.uploads).toHaveLength(0);
    expect(again.notes).toHaveLength(0);
  });

  it('never saves an unverified sender and warns only once', async () => {
    const state = {};
    const first = deps([found('x', '2026-11-15', false)]);
    await runRules([rule], first.d, state);
    expect(first.uploads).toHaveLength(0);
    expect(first.notes[0]).toMatch(/could not verify/);
    const second = deps([found('x', '2026-11-15', false)]);
    await runRules([rule], second.d, state);
    expect(second.notes).toHaveLength(0);
  });

  it('reports an upload failure once, retries, and reports the later success', async () => {
    const state = {};
    const fail = deps([found('m1', '2026-11-15')], {
      archive: async () => {
        throw new Error('Paperless error 502');
      },
    });
    await runRules([rule], fail.d, state);
    expect(fail.notes).toEqual([
      "Couldn't save the payslip from Nov 15, 2026: Paperless error 502. I'll retry every hour.",
    ]);
    const failAgain = deps([found('m1', '2026-11-15')], {
      archive: async () => {
        throw new Error('Paperless error 502');
      },
    });
    await runRules([rule], failAgain.d, state);
    expect(failAgain.notes).toHaveLength(0);
    const ok = deps([found('m1', '2026-11-15')]);
    await runRules([rule], ok.d, state);
    expect(ok.notes).toEqual(['Saved payslip for Nov 15, 2026 to Paperless.']);
  });

  it('treats an unconfirmed upload as a failure without marking it done', async () => {
    const state: Record<string, { done: Record<string, string> }> = {};
    const { d, notes } = deps([found('m1', '2026-11-15')], {
      archive: async () => 'Upload outcome for "Payslip.pdf" is unknown. Check with archive_status',
    });
    await runRules([rule], d, state as never);
    expect(notes[0]).toMatch(/did not confirm/);
    expect(state.payslips.done.m1).toBeUndefined();
  });

  it('reports a search failure once and the recovery', async () => {
    const state = {};
    const a = deps(new Error('Google sign-in for "personal" is needed again'));
    await runRules([rule], a.d, state);
    const b = deps(new Error('Google sign-in for "personal" is needed again'));
    await runRules([rule], b.d, state);
    const c = deps([]);
    await runRules([rule], c.d, state);
    expect(a.notes).toHaveLength(1);
    expect(b.notes).toHaveLength(0);
    expect(c.notes).toEqual(['Mail checks for payslips work again.']);
  });

  it('dry run changes nothing and posts nothing', async () => {
    const state = {};
    const { d, uploads, notes } = deps([found('m1', '2026-11-15')]);
    const lines = await runRules([rule], d, state, { dryRun: true });
    expect(uploads).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(lines).toEqual(['[payslips] would save Payslip 2026-11-15 (Payslip.pdf)']);
  });

  it('finds the exact attachment in nested parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: {} },
        {
          mimeType: 'multipart/mixed',
          parts: [
            { filename: 'Payslip-old.pdf', body: { attachmentId: 'no' } },
            { filename: 'PAYSLIP.PDF', body: { attachmentId: 'yes' } },
          ],
        },
      ],
    };
    expect(
      (findAttachment(payload as never, 'Payslip.pdf') as { body: { attachmentId: string } }).body.attachmentId,
    ).toBe('yes');
    expect(findAttachment(payload as never, 'Other.pdf')).toBeNull();
  });

  it('builds the query and local dates', () => {
    expect(gmailQuery(rule)).toBe('from:payroll@example.com has:attachment filename:"Payslip.pdf"');
    expect(localDate(new Date('2026-11-16T05:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-15');
  });

  it('validates mail_archive rules in home.yaml', () => {
    const base = `
version: 1
agents: [bono]
google_accounts:
  - {id: personal, address: a@example.com, scopes: [gmail.readonly]}
  - {id: cal, address: b@example.com, scopes: [calendar.readonly]}
mailboxes: []
calendars: []
reminders: {unrestricted: [], lists: []}
omnifocus: {used_by: []}
notes: {unrestricted: [], read_all: [], folders: []}
destinations: {}
personal_watch: []
schedule: {quiet_hours: "21:00-07:00", brief_time: "19:00", stale_days: 21, nudge_cap: 3}
`;
    const ok = parseHomeConfig(
      `${base}mail_archive:\n  - {id: payslips, account: personal, from: Payroll@Example.com, attachment: Payslip.pdf, title: Payslip, notify: alex}\n`,
    );
    expect(ok.mail_archive?.[0].from).toBe('payroll@example.com');
    expect(() =>
      parseHomeConfig(
        `${base}mail_archive:\n  - {id: p, account: cal, from: x@example.com, attachment: a.pdf, title: T}\n`,
      ),
    ).toThrow(/lacks gmail.readonly/);
    expect(() =>
      parseHomeConfig(
        `${base}mail_archive:\n  - {id: p, account: personal, from: x@example.com, attachment: a.pdf, title: T, share: yes}\n`,
      ),
    ).toThrow(/true or false/);
  });
});
