import { describe, expect, it } from 'vitest';

import {
  type Deps,
  hints,
  matchByName,
  type PackageEntry,
  parseReview,
  preprocess,
  runOnce,
  type State,
  suggestionText,
  updatePackages,
} from './mail-review-local.js';

const NOW = new Date('2026-11-16T19:30:00Z'); // 11:30 PST

describe('mail-review-local preprocessing', () => {
  it('drops quoted text, signatures, footers and long links', () => {
    const text = [
      'Your bill is ready.',
      'Amount due: $123.45 by Dec 3, 2026',
      'https://example.com/' + 'x'.repeat(80),
      'Unsubscribe from these emails',
      '> old quoted line',
      '-- ',
      'Signature here',
    ].join('\n');
    const out = preprocess(text);
    expect(out).toContain('Amount due: $123.45');
    expect(out).toContain('[link]');
    expect(out).not.toMatch(/Unsubscribe|quoted|Signature/);
  });

  it('finds amounts, tracking numbers and dates', () => {
    const h = hints('Total $1,234.56. UPS 1Z999AA10123456784 arriving Tue, Nov 18. USPS 9400111899223197428490');
    expect(h.amounts).toEqual(['$1,234.56']);
    expect(h.tracking.map((t) => t.carrier)).toEqual(['UPS', 'USPS']);
    expect(h.dates[0]).toMatch(/Nov 18/);
  });
});

describe('mail-review-local model contract', () => {
  it('validates the model JSON and drops bad dates', () => {
    expect(parseReview('nope')).toBeNull();
    expect(parseReview('{"category":"spam","summary":"x"}')).toBeNull();
    const r = parseReview(
      '{"category":"bill","summary":"PG&E $123","payee":"PG&E","amount":"$123.45","due_date":"Dec 3"}',
    )!;
    expect(r.payee).toBe('PG&E');
    expect(r.due_date).toBeUndefined();
  });

  it('matches bills to tasks by meaningful words', () => {
    const tasks = [
      { source: 'omnifocus' as const, title: 'Airtel bill' },
      { source: 'omnifocus' as const, title: 'Amex bonvoy' },
    ];
    expect(matchByName('Airtel Payments Bank', tasks)?.title).toBe('Airtel bill');
    expect(matchByName('PG&E', tasks)).toBeNull();
    expect(matchByName('Credit Card Bill', tasks)).toBeNull(); // only generic words
  });

  it('builds a self-contained suggestion reply', () => {
    const { reply, text, items } = suggestionText(
      { category: 'bill', summary: 'Statement ready', payee: 'PG&E', amount: '$123.45', due_date: '2026-12-03' },
      'PG&E',
    );
    expect(reply).toBe('add bill PG&E $123.45 due 2026-12-03');
    expect(text).toContain('No open task');
    expect(items[0]).toMatchObject({ actions: ['add', 'dismiss'], title: 'PG&E $123.45 due 2026-12-03' });
  });

  it('merges package updates by tracking number and expires old ones', () => {
    const base: PackageEntry = {
      messageId: 'a',
      from: 'Amazon',
      tracking: 'TBA1',
      status: 'shipped',
      summary: 's',
      seenAt: NOW.toISOString(),
    };
    let list = updatePackages([], base, NOW);
    list = updatePackages(list, { ...base, messageId: 'b', status: 'delivered' }, NOW);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('delivered');
    const later = new Date(NOW.getTime() + 3 * 86400000);
    expect(updatePackages(list, null, later)).toHaveLength(0);
  });
});

describe('mail-review-local run', () => {
  function deps(reviews: Record<string, string>, tasks = [{ source: 'omnifocus' as const, title: 'Airtel bill' }]) {
    const notes: string[] = [];
    const d: Deps = {
      timezone: 'America/Los_Angeles',
      now: () => NOW,
      listNew: async () => Object.keys(reviews).map((id, i) => ({ id, internalDate: NOW.getTime() - 3600_000 + i })),
      fetch: async (id) => ({ id, internalDate: 0, from: 'Sender', subject: id, text: `mail ${id}` }),
      classify: async (_s, user) => reviews[user.match(/Subject: (\S+)/)![1]],
      pickTask: async () => null,
      billTasks: async () => tasks,
      notify: async (t) => {
        notes.push(t);
      },
    };
    return { d, notes };
  }

  it('suggests only uncovered bills, tracks packages and never repeats', async () => {
    const { d, notes } = deps({
      m1: '{"category":"bill","summary":"Airtel bill ₹999","payee":"Airtel","amount":"₹999"}',
      m2: '{"category":"bill","summary":"PG&E $120 due Dec 3","payee":"PG&E","amount":"$120","due_date":"2026-12-03"}',
      m3: '{"category":"package","summary":"Shoes shipped","carrier":"UPS","tracking":"1Z1","eta":"2026-11-18","package_status":"shipped"}',
      m4: '{"category":"ignore","summary":"newsletter"}',
    });
    const state: State = { since: 0, done: {} };
    const r = await runOnce(d, state, [], { maxPerRun: 10, digestHour: 23 });
    expect(r.reviewed).toBe(4);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/New bill: PG&E/);
    expect(state.done.m1.bill).toMatch(/covered by "Airtel bill"/);
    expect(r.packages.map((p) => p.tracking)).toEqual(['1Z1']);
    const again = await runOnce(d, state, r.packages, { maxPerRun: 10, digestHour: 23 });
    expect(again.reviewed).toBe(0);
    expect(notes).toHaveLength(1);
  });

  it('stops on a model outage and keeps the mail pending', async () => {
    const { d } = deps({ m1: '{}' });
    d.classify = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const state: State = { since: 0, done: {} };
    const r = await runOnce(d, state, [], { maxPerRun: 10, digestHour: 23 });
    expect(r.errors[0]).toMatch(/model/);
    expect(state.done.m1).toBeUndefined();
  });

  it('sends one digest a day after the digest hour', async () => {
    const { d, notes } = deps({
      m1: '{"category":"action","summary":"Form due","action":"Sign the field-trip form by Fri"}',
    });
    const state: State = { since: 0, done: {} };
    await runOnce(d, state, [], { maxPerRun: 10, digestHour: 10 });
    await runOnce(d, state, [], { maxPerRun: 10, digestHour: 10 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Needs action\*\*\n- Sign the field-trip form/);
  });
});
