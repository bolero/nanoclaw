import { describe, expect, it } from 'vitest';

import {
  type Deps,
  hints,
  matchByName,
  type PackageEntry,
  parseReview,
  preprocess,
  runOnce,
  actionSuggestion,
  type State,
  suggestionText,
  updatePackages,
  findOrder,
  inferStatus,
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

  it('collapses the order, shipped and delivered mails for one order', () => {
    const at = (h: number) => new Date(NOW.getTime() + h * 3600000).toISOString();
    const mk = (id: string, p: Partial<PackageEntry>): PackageEntry => ({ messageId: id, from: 'Amazon.com', summary: '', seenAt: at(0), ...p });
    const list = updatePackages(
      [
        mk('1', { item: 'Coffee, Oral Care', summary: 'Amazon order #114-2254218-7062650: Coffee, Oral Care. Total: 34.58 USD.' }),
        mk('2', { item: 'Oral Care', summary: 'Amazon shipped 1 item (Oral Care). Order #114-2254218-7062650.', seenAt: at(1) }),
        mk('3', { item: '2 items (Industrial & Scientific)', summary: 'Amazon order #114-8827510-2477833 shipped.' }),
        mk('4', { item: '2 items: Industrial & Scientific', summary: '2 items from Amazon delivered today to San Jose, CA.', seenAt: at(2) }),
        mk('5', { item: 'Industrial & Scientific', summary: 'Amazon shipment, Order #114-5640576-9672254.' }),
        mk('6', { from: 'AliExpress', item: 'not specified', summary: 'AliExpress order 8215391793057999 ($11.30) will be marked as completed soon.' }),
        mk('7', { from: 'Bambu Lab', item: 'PLA Matte filaments and Bambu Reusable Spools', summary: 'Bambu Lab order us798718556266119168 confirmed.' }),
        mk('8', { from: 'Bambu Lab', item: 'PLA Matte refills and spools', summary: 'Bambu Lab shipment is out for delivery via Ontrac. Tracking: D10017876271271.', seenAt: at(3) }),
      ],
      null,
      NOW,
    );
    expect(list).toHaveLength(5);
    const coffee = list.find((p) => p.order === '114-2254218-7062650')!;
    expect(coffee.item).toBe('Coffee, Oral Care');
    expect(coffee.status).toBe('shipped');
    expect(list.find((p) => p.messageId === '4')?.status).toBe('delivered');
    expect(list.find((p) => p.from === 'AliExpress')?.item).toBeUndefined();
    expect(list.find((p) => p.from === 'Bambu Lab')?.status).toBe('out_for_delivery');
    expect(list.at(-1)?.status).toBe('delivered');
  });

  it('reads order numbers and status from text', () => {
    expect(findOrder('Lands\' End order #6135349-1: 2x jackets')).toBe('6135349-1');
    expect(findOrder('Order #114-0763144-7905816')).toBe('114-0763144-7905816');
    expect(findOrder('order now and save')).toBeUndefined();
    expect(inferStatus('Luggage delivered today to San Jose')).toBe('delivered');
    expect(inferStatus('is out for delivery via Ontrac')).toBe('out_for_delivery');
    expect(inferStatus('Arriving Thursday')).toBe('shipped');
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
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^\*\*To do from email: Sign the field-trip form by Fri\*\*/);
    expect(notes[1]).toMatch(/Needs action\*\*\n- Sign the field-trip form/);
  });

  it('suggests action emails right away with Add task / Dismiss, except starred ones', async () => {
    const { d, notes } = deps({
      m1: '{"category":"action","summary":"Camp RSVP","action":"Confirm Fall Camp attendance","due_date":"2026-11-19"}',
      m2: '{"category":"action","summary":"Starred thing","action":"Reply to teacher"}',
    });
    const items: object[][] = [];
    d.notify = async (t, it) => {
      notes.push(t);
      if (it) items.push(it);
    };
    d.fetch = async (id) => ({
      id,
      internalDate: 0,
      from: 'School',
      subject: id,
      text: `mail ${id}`,
      starred: id === 'm2',
    });
    const state: State = { since: 0, done: {} };
    await runOnce(d, state, [], { maxPerRun: 10, digestHour: 23 });
    expect(notes).toHaveLength(1);
    expect(items[0][0]).toEqual({
      id: 'mailaction:m1',
      title: 'Confirm Fall Camp attendance (due 2026-11-19)',
      detail: 'School · due 2026-11-19',
      next: 'Add a reminder due 2026-11-19',
      actions: ['add', 'dismiss'],
    });
    expect(state.done.m2.suggested).toMatch(/starred/);
    expect(
      actionSuggestion({ category: 'action', summary: 's', due_date: 'soon' }, { from: 'X', subject: '' }).items[0],
    ).toMatchObject({ title: 's' });
  });
});

describe('mail-review-local profiles', () => {
  it('reads profiles, skips bad ones, and never lends the owner bridges to a configured person', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { loadProfiles } = await import('./mail-review-local.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-'));
    const file = path.join(dir, 'mail-review.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        profiles: [
          { handle: 'alex', account: 'personal', omnifocus_url: 'http://of' },
          { handle: 'Bad Handle', account: 'x' },
          { handle: 'sam', account: 'sam-mail' },
          { handle: 'alex', account: 'dup' },
        ],
      }),
    );
    const p = loadProfiles(file, {});
    expect(p.map((x) => x.handle)).toEqual(['alex', 'sam']);
    expect(p.every((x) => x.owner_bridges === false)).toBe(true);
    const legacy = loadProfiles(path.join(dir, 'missing.json'), { MAIL_REVIEW_NOTIFY: 'alex' });
    expect(legacy).toEqual([expect.objectContaining({ handle: 'alex', account: 'personal', owner_bridges: true })]);
    expect(loadProfiles(path.join(dir, 'missing.json'), {})).toEqual([]);
  });

  it('moves the original single-mailbox state into its owner folder once', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { migrateLegacyState } = await import('./mail-review-local.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrm-'));
    fs.writeFileSync(path.join(root, 'state.json'), '{"since":0,"done":{}}');
    fs.writeFileSync(path.join(root, 'packages.json'), '{"handle":"alex","packages":[]}');
    migrateLegacyState(root, 'sam');
    expect(fs.existsSync(path.join(root, 'sam'))).toBe(false);
    migrateLegacyState(root, 'alex');
    expect(fs.existsSync(path.join(root, 'alex', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'state.json'))).toBe(false);
  });
});

describe('addOllamaStats', () => {
  it('sums tokens and converts nanoseconds to ms', async () => {
    const { addOllamaStats } = await import('./mail-review-local.js');
    const s = { requests: 0, failed: 0, promptTokens: 0, outputTokens: 0, totalMs: 0, loadMs: 0 };
    addOllamaStats(s, { prompt_eval_count: 100, eval_count: 20, total_duration: 1_500_000_000, load_duration: 2_000_000 });
    addOllamaStats(s, { eval_count: 5 });
    expect(s).toEqual({ requests: 2, failed: 0, promptTokens: 100, outputTokens: 25, totalMs: 1500, loadMs: 2 });
  });
});
