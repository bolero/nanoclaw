import { describe, expect, it } from 'vitest';

import { extractItems, validateItems } from '../app.js';

describe('app action items', () => {
  it('extracts a bono-actions block and strips it from the text', () => {
    const text = [
      '**Evening brief**',
      '',
      '```bono-actions',
      JSON.stringify([
        {
          id: 'omnifocus:abc',
          title: 'Sell camera',
          detail: 'OmniFocus · overdue',
          next: 'Draft a listing',
          actions: ['done', 'snooze', 'next', 'bogus'],
        },
        { id: 'bad id!', title: 'x', actions: ['done'] },
        { id: 'reminders:1', title: 'No actions', actions: [] },
      ]),
      '```',
      '',
      'Tomorrow: nothing.',
    ].join('\n');
    const r = extractItems(text);
    expect(r.text).toBe('**Evening brief**\n\nTomorrow: nothing.');
    expect(r.items).toEqual([
      {
        id: 'omnifocus:abc',
        title: 'Sell camera',
        detail: 'OmniFocus · overdue',
        next: 'Draft a listing',
        actions: ['done', 'snooze', 'next'],
      },
    ]);
  });

  it('leaves text without a block alone and rejects junk', () => {
    expect(extractItems('hello').items).toBeNull();
    expect(extractItems('a\n```bono-actions\nnot json\n```').items).toBeNull();
    expect(validateItems('x')).toBeNull();
  });
});
