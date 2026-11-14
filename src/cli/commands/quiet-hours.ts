/**
 * `ncl quiet-hours get|set` — the one install-wide quiet-hours switch (src/quiet-hours.ts).
 * get is open to every agent; set is approval-gated for agents (the owner approves the card)
 * and direct for the host operator.
 *
 *   ncl quiet-hours get
 *   ncl quiet-hours set [--enabled true|false] [--start HH:MM] [--end HH:MM]
 */
import { TIMEZONE } from '../../config.js';
import {
  describeQuietHours,
  normalizeTime,
  type QuietHours,
  readQuietHours,
  writeQuietHours,
} from '../../quiet-hours.js';
import { register } from '../registry.js';

interface SetArgs {
  enabled?: boolean;
  start?: string;
  end?: string;
}

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === true) return true;
  const s = String(v).trim().toLowerCase();
  if (['true', 'on', 'yes', '1'].includes(s)) return true;
  if (['false', 'off', 'no', '0'].includes(s)) return false;
  throw new Error('--enabled must be true or false');
}

function parseSet(raw: Record<string, unknown>): SetArgs {
  const out: SetArgs = {};
  const enabled = parseBool(raw.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  if (raw.start !== undefined) out.start = normalizeTime(String(raw.start));
  if (raw.end !== undefined) out.end = normalizeTime(String(raw.end));
  if (out.enabled === undefined && !out.start && !out.end) {
    throw new Error('give at least one of --enabled true|false, --start HH:MM, --end HH:MM');
  }
  return out;
}

function merged(args: SetArgs, current = readQuietHours()): QuietHours {
  return {
    enabled: args.enabled ?? current.enabled,
    start: args.start ?? current.start,
    end: args.end ?? current.end,
  };
}

const fmt = (q: QuietHours): string => describeQuietHours(q, TIMEZONE);

register({
  name: 'quiet-hours-get',
  description:
    'Show the install-wide quiet hours and whether they are active right now. Agents: check this before sending a non-urgent message. Usage: ncl quiet-hours get',
  access: 'open',
  resource: 'quiet-hours',
  parseArgs: () => ({}),
  handler: async () => {
    const q = readQuietHours();
    return { ...q, timezone: TIMEZONE, activeNow: describeQuietHours(q, TIMEZONE).includes('ACTIVE NOW') };
  },
  formatHuman: (d: QuietHours) => fmt(d),
});

register({
  name: 'quiet-hours-set',
  description:
    'Turn the install-wide quiet hours on or off, or change the window (install timezone, 24-hour). Applies to app push notifications and to every agent. Agents need the owner to approve. Usage: ncl quiet-hours set [--enabled true|false] [--start HH:MM] [--end HH:MM]',
  access: 'approval',
  resource: 'quiet-hours',
  parseArgs: parseSet,
  preApproval: async (raw) => `Quiet hours will become: ${fmt(merged(parseSet(raw)))}`,
  handler: async (args: SetArgs, ctx) => {
    const by = ctx.caller === 'agent' ? `agent ${ctx.agentGroupId}` : 'host';
    return writeQuietHours({ ...merged(args), updatedBy: by });
  },
  formatHuman: (d: QuietHours) => `Saved. ${fmt(d)}`,
});
