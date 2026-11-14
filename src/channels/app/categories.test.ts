import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { extractCategory, isDecline } from '../app.js';
import { AppStore } from './store.js';

describe('app message categories and card lifecycle', () => {
  it('extracts and strips the hidden kind tag', () => {
    expect(extractCategory('<!-- kind: suggestion -->\nRenewal due Dec 3.')).toEqual({
      text: 'Renewal due Dec 3.',
      category: 'suggestion',
    });
    expect(extractCategory('<!--kind:Done-->Added it.').category).toBe('done');
    expect(extractCategory('<!-- kind: bogus -->\nHi').category).toBeNull();
    expect(extractCategory('Plain text <!-- kind: done -->').category).toBeNull();
  });

  it('recognizes decline options', () => {
    expect(isDecline({ label: 'Not now', value: 'later' })).toBe(true);
    expect(isDecline({ label: 'Deny', value: 'deny' })).toBe(true);
    expect(isDecline({ label: 'Add school reminder', value: 'add' })).toBe(false);
    expect(isDecline({ label: 'Notify me', value: 'notify' })).toBe(false);
  });

  it('stores categories and links a done report to the working card', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-cat-'));
    const store = new AppStore(dir);
    const conv = 'app:alex:family';
    const base = {
      conversationId: conv,
      userHandle: 'alex',
      direction: 'out' as const,
      files: [],
      senderName: null,
      failure: false,
    };
    const card = store.insertMessage({
      ...base,
      id: 'c1',
      kind: 'card',
      text: 'Add it?',
      card: {
        questionId: 'q1',
        title: 'School event',
        question: 'Add it?',
        options: [],
        status: 'working',
        answeredAt: new Date().toISOString(),
      },
    });
    expect(card.category).toBeNull();
    const note = store.insertMessage({ ...base, id: 'm1', kind: 'text', text: 'FYI', card: null, category: 'notice' });
    expect(note.category).toBe('notice');
    expect(store.linkCardResult(conv, note)).toBeNull(); // only done/failed reports link
    const done = store.insertMessage({ ...base, id: 'm2', kind: 'text', text: 'Added.', card: null, category: 'done' });
    const linked = store.linkCardResult(conv, done)!;
    expect(linked.card?.status).toBe('completed');
    expect(linked.card?.resultMessageId).toBe('m2');
    expect(linked.rev).toBeGreaterThan(done.rev);
    // A second report finds no working card.
    const again = store.insertMessage({ ...base, id: 'm3', kind: 'text', text: 'x', card: null, category: 'failed' });
    expect(store.linkCardResult(conv, again)).toBeNull();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
