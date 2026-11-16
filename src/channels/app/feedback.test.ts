import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { formatFeedback, summarizeFeedback } from './feedback.js';
import { AppStore } from './store.js';

const base = {
  userHandle: 'alex',
  direction: 'out' as const,
  files: [],
  failure: false,
  card: null,
  kind: 'text' as const,
};

describe('app feedback', () => {
  it('stores verdicts and summarizes the hit rate per sender, scoped by conversation', () => {
    const store = new AppStore(fs.mkdtempSync(path.join(os.tmpdir(), 'app-fb-')));
    const since = new Date(Date.now() - 86_400_000).toISOString();
    store.insertMessage({
      ...base,
      id: 'm1',
      conversationId: 'app:alex',
      text: '## Bill: Amex\nmore',
      senderName: 'Mail review',
      category: 'suggestion',
    });
    store.insertMessage({
      ...base,
      id: 'm2',
      conversationId: 'app:alex',
      text: 'Evening brief',
      senderName: 'bono',
      category: 'brief',
      items: [
        { id: 'a', title: 'A', actions: ['done'] },
        { id: 'b', title: 'B', actions: ['drop'] },
        { id: 'c', title: 'C', actions: ['done'] },
      ],
    });
    store.insertMessage({ ...base, id: 'm3', conversationId: 'app:alex', text: 'plain chat', senderName: 'bono' });
    store.insertMessage({
      ...base,
      id: 'm4',
      conversationId: 'app:alex/family',
      text: 'Family brief',
      senderName: 'family',
      category: 'brief',
    });

    const before = store.getMessage('m1')!.rev;
    const rated = store.setFeedback('m1', 'not_useful')!;
    expect(rated.feedback).toBe('not_useful');
    expect(rated.rev).toBeGreaterThan(before);
    store.setFeedback('m2', 'useful');
    store.setItemState('m2', 'a', 'done', 'Done');
    store.setItemState('m2', 'b', 'dropped', 'Dropped');

    const all = store.feedbackSince(since);
    expect(all.map((r) => r.id)).toEqual(['m1', 'm2', 'm4']);
    expect(all[0].preview).toBe('Bill: Amex');

    const s = summarizeFeedback(all, since);
    expect(s).toMatchObject({ shown: 3, useful: 1, notUseful: 1, hitRate: 0.5, itemsTakenUp: 0.5 });
    expect(s.senders.find((x) => x.sender === 'bono')!.items).toEqual({ done: 1, dropped: 1, open: 1 });
    expect(s.misses).toEqual([expect.objectContaining({ id: 'm1', sender: 'Mail review' })]);
    expect(formatFeedback(s)).toContain('hit rate 50%');

    expect(store.feedbackSince(since, ['app:alex/family']).map((r) => r.id)).toEqual(['m4']);
    expect(store.feedbackSince(since, [])).toEqual([]);
    expect(store.setFeedback('m1', null)!.feedback).toBeNull();
  });

  it('reports no hit rate when nothing was rated', () => {
    expect(summarizeFeedback([], 'x')).toMatchObject({ shown: 0, hitRate: null, itemsTakenUp: null });
  });
});
