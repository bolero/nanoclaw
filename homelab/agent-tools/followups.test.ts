import { describe as group, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';

import { main, minutes, runCheck } from './followups.ts';

const tmp = () => `${fs.mkdtempSync(`${os.tmpdir()}/fu-`)}/f.json`;
const T0 = '2026-11-28T10:00:00Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

group('followups', () => {
  it('parses durations', () => {
    expect(minutes('15m', 1)).toBe(15);
    expect(minutes('2h', 1)).toBe(120);
    expect(minutes('3d', 1)).toBe(4320);
    expect(minutes(undefined, 7)).toBe(7);
    expect(() => minutes('soon', 1)).toThrow('bad duration');
  });

  it('a scripted check closes the item and wakes once; pending stays quiet and backs off', async () => {
    const state = tmp();
    let answer: any = { state: 'pending' };
    const check = () => answer;
    const run = (min: number, ...a: string[]) => main([...a, '--state', state, '--now', at(min)], check) as Promise<any>;
    const { added } = await run(0, 'add', '--title', 'Dune (film) for Abhijeet', '--chat', 'app-bolero-family', '--for', 'Abhijeet', '--check', 'x');
    expect(added).toMatchObject({ id: 1, status: 'open', checkedBy: 'script' });
    expect((await run(5, 'watch')).wakeAgent).toBe(false); // not due yet
    expect((await run(15, 'watch')).wakeAgent).toBe(false); // pending
    const listed = (await run(16, 'list')).followups[0];
    expect(listed.nextCheck).toBe(at(15 + 23)); // 15 x 1.5
    answer = { state: 'done', detail: 'available in Silo' };
    const out = await run(40, 'watch');
    expect(out.wakeAgent).toBe(true);
    expect(out.data.items[0]).toMatchObject({ id: 1, kind: 'done', detail: 'available in Silo', chat: 'app-bolero-family' });
    expect((await run(80, 'watch')).wakeAgent).toBe(false);
    expect((await run(81, 'list')).followups).toEqual([]);
  });

  it('without a check the agent is woken to look; later and done are respected', async () => {
    const state = tmp();
    const run = (min: number, ...a: string[]) => main([...a, '--state', state, '--now', at(min)]) as Promise<any>;
    await run(0, 'add', '--title', 'Ask the school about the trip form', '--chat', 'app-bavya-family', '--every', '1h');
    const w = await run(60, 'watch');
    expect(w.data.items[0]).toMatchObject({ kind: 'check', checkedBy: 'you' });
    await run(61, 'later', '1', '--in', '3h');
    expect((await run(150, 'watch')).wakeAgent).toBe(false);
    await run(151, 'done', '1', '--note', 'form sent');
    expect((await run(400, 'watch')).wakeAgent).toBe(false);
    expect((await run(401, 'list', '--all', 'yes')).followups[0]).toMatchObject({ status: 'done', outcome: 'form sent' });
  });

  it('tells the agent when something is overdue, then again after the same time', async () => {
    const state = tmp();
    const check = () => ({ error: 'Seerr GET /request/9 -> 502' });
    const run = (min: number, ...a: string[]) => main([...a, '--state', state, '--now', at(min)], check) as Promise<any>;
    await run(0, 'add', '--title', 'Bluey S3', '--chat', 'app-bolero-family', '--check', 'x', '--give-up', '1d');
    expect((await run(600, 'watch')).wakeAgent).toBe(false); // errors alone do not wake
    const o = await run(1440, 'watch');
    expect(o.data.items).toEqual([expect.objectContaining({ kind: 'overdue', detail: 'last check failed: Seerr GET /request/9 -> 502' })]);
    expect((await run(1500, 'watch')).wakeAgent).toBe(false);
    expect((await run(2880, 'watch')).data.items[0].kind).toBe('overdue');
    await run(2881, 'drop', '1');
    expect((await run(9000, 'watch')).wakeAgent).toBe(false);
  });

  it('refuses incomplete adds and unknown ids', async () => {
    const state = tmp();
    await expect(main(['add', '--title', 'x', '--state', state])).rejects.toThrow('usage: add');
    await expect(main(['done', '4', '--state', state])).rejects.toThrow('no follow-up #4');
  });

  it('runs real check commands', () => {
    expect(runCheck(`echo noise; echo '{"state":"done","detail":"ok"}'`)).toEqual({ state: 'done', detail: 'ok' });
    expect(runCheck(`echo '{"state":"maybe"}'`)).toMatchObject({ error: expect.stringContaining('no state') });
    expect(runCheck(`echo boom >&2; exit 3`)).toEqual({ error: 'boom' });
  });
});
