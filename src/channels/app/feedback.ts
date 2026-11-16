/**
 * Weekly hit rate for what agents and host jobs raise in the app: how many
 * suggestions/briefs/digests were marked Useful or Not useful, and what happened
 * to their per-item buttons. Pure, so the CLI, dashboard and tests share it.
 */
import type { FeedbackRow } from './store.js';

export interface SenderSummary {
  sender: string;
  shown: number;
  useful: number;
  notUseful: number;
  /** Item outcomes: done, snoozed, dropped, stopped, sent, dismissed; plus open (untouched). */
  items: Record<string, number>;
}

export interface FeedbackSummary {
  since: string;
  shown: number;
  useful: number;
  notUseful: number;
  /** useful / (useful + notUseful), or null when nothing was rated. */
  hitRate: number | null;
  /** Share of items acted on (anything but dismissed/stopped/dropped counts as taken up). */
  itemsTakenUp: number | null;
  senders: SenderSummary[];
  /** The messages marked Not useful, newest first, so the agent can see what missed. */
  misses: Array<{ id: string; sender: string; preview: string; createdAt: string }>;
}

const TAKEN = new Set(['done', 'snoozed', 'sent']);
const REJECTED = new Set(['dropped', 'stopped', 'dismissed']);

export function summarizeFeedback(rows: FeedbackRow[], since: string): FeedbackSummary {
  const by = new Map<string, SenderSummary>();
  let useful = 0;
  let notUseful = 0;
  let taken = 0;
  let rejected = 0;
  for (const r of rows) {
    const sender = r.sender ?? 'agent';
    const s = by.get(sender) ?? { sender, shown: 0, useful: 0, notUseful: 0, items: {} };
    s.shown++;
    if (r.feedback === 'useful') (s.useful++, useful++);
    if (r.feedback === 'not_useful') (s.notUseful++, notUseful++);
    for (const [state, n] of Object.entries(r.itemStates)) {
      s.items[state] = (s.items[state] ?? 0) + n;
      if (TAKEN.has(state)) taken += n;
      if (REJECTED.has(state)) rejected += n;
    }
    if (r.itemsOpen) s.items.open = (s.items.open ?? 0) + r.itemsOpen;
    by.set(sender, s);
  }
  return {
    since,
    shown: rows.length,
    useful,
    notUseful,
    hitRate: useful + notUseful ? useful / (useful + notUseful) : null,
    itemsTakenUp: taken + rejected ? taken / (taken + rejected) : null,
    senders: [...by.values()].sort((a, b) => b.shown - a.shown),
    misses: rows
      .filter((r) => r.feedback === 'not_useful')
      .reverse()
      .map((r) => ({ id: r.id, sender: r.sender ?? 'agent', preview: r.preview, createdAt: r.createdAt })),
  };
}

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

export function formatFeedback(s: FeedbackSummary): string {
  const lines = [
    `Since ${s.since.slice(0, 10)}: ${s.shown} suggestions/briefs/digests · ${s.useful} useful · ${s.notUseful} not useful · hit rate ${pct(s.hitRate)} · items taken up ${pct(s.itemsTakenUp)}`,
  ];
  for (const x of s.senders) {
    const items = Object.entries(x.items)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    lines.push(
      `- ${x.sender}: ${x.shown} shown, ${x.useful} useful, ${x.notUseful} not useful${items ? `; items: ${items}` : ''}`,
    );
  }
  if (s.misses.length) {
    lines.push('Marked not useful:');
    for (const m of s.misses.slice(0, 20)) lines.push(`- ${m.createdAt.slice(0, 10)} ${m.sender}: ${m.preview}`);
  }
  return lines.join('\n');
}
