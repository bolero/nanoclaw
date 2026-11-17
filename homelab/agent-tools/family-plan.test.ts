import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { load, main } from './family-plan.ts';

const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')), 'plan.json');
const TODAY = '2026-11-16';

describe('family plan', () => {
  it('sets and clears meals, validating dates and meal names', () => {
    const f = fresh();
    main(['meal', 'set', '2026-11-17', 'dinner', 'Dal', 'and', 'rice'], f, TODAY);
    main(['meal', 'set', '2026-11-17', 'lunch', 'Pasta'], f, TODAY);
    expect(load(f).meals['2026-11-17']).toEqual({ dinner: 'Dal and rice', lunch: 'Pasta' });
    main(['meal', 'clear', '2026-11-17', 'lunch'], f, TODAY);
    expect(load(f).meals['2026-11-17']).toEqual({ dinner: 'Dal and rice' });
    expect(() => main(['meal', 'set', '2026-13-01', 'dinner', 'x'], f, TODAY)).toThrow(/bad date/);
    expect(() => main(['meal', 'set', '2026-11-18', 'brunch', 'x'], f, TODAY)).toThrow(/meal must be/);
  });

  it('adds drives once, sets drivers, lists the open ones', () => {
    const f = fresh();
    const id = main(['drive', 'add', '2026-11-17', '16:00', 'Ballet', '--who', 'Aanya'], f, TODAY);
    expect(main(['drive', 'add', '2026-11-17', '16:00', 'ballet'], f, TODAY)).toBe(id);
    main(['drive', 'add', '2026-11-16', '-', 'Gymnastics'], f, TODAY);
    expect(JSON.parse(main(['drive', 'open'], f, TODAY)).map((d: { title: string }) => d.title)).toEqual([
      'Gymnastics',
      'Ballet',
    ]);
    main(['drive', 'set', id, '--drop', 'Bavya', '--pickup', 'Abhijeet'], f, TODAY);
    expect(JSON.parse(main(['drive', 'open'], f, TODAY)).map((d: { title: string }) => d.title)).toEqual([
      'Gymnastics',
    ]);
    expect(() => main(['drive', 'add', '2026-11-17', '25:00', 'x'], f, TODAY)).toThrow(/bad time/);
    expect(() => main(['drive', 'set', 'nope', '--drop', 'x'], f, TODAY)).toThrow(/no drive/);
  });

  it('drops entries older than two weeks and shows a window from today', () => {
    const f = fresh();
    main(['meal', 'set', '2026-10-01', 'dinner', 'Old'], f, TODAY);
    main(['meal', 'set', '2026-11-20', 'dinner', 'Soon'], f, TODAY);
    expect(Object.keys(load(f).meals)).toEqual(['2026-11-20']);
    expect(Object.keys(JSON.parse(main(['show', '--days', '3'], f, TODAY)).meals)).toEqual([]);
  });
});
