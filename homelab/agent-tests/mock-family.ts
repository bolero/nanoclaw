/**
 * Scenario mock for the family agent: real GoogleBroker over a fake Google, fake Reminders and
 * Notes MCP servers. Records every tool call. Admin: POST /admin/scenario (JSON), GET /admin/calls.
 * Run from the repo root: pnpm exec tsx homelab/agent-tests/mock-family.ts
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { GoogleBroker, handleRpc, type StateStore } from '../../scripts/google-broker.ts';
import { parseHomeConfig } from '../../scripts/home-config.ts';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const cfg = parseHomeConfig(
  fs.readFileSync(path.join(DIR, '..', 'home.example.yaml'), 'utf8'),
);

interface Ev { id: string; summary: string; start: any; end: any; location?: string; description?: string; extendedProperties?: any }
interface Rem { id: string; title: string; list: string; due?: string; completed?: boolean; notes?: string }
let sc: { messages: any[]; events: Record<string, Ev[]>; reminders: Rem[]; now?: string } = { messages: [], events: {}, reminders: [] };
let calls: unknown[] = [];
let seq = 1;
const rec = (server: string, name: string, args: unknown, result: string) => calls.push({ server, name, args, result: result.slice(0, 400) });

const calIds: Record<string, string> = { 'cal-family': 'Family', 'cal-school': 'School' };
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const p = url.pathname;
  if (p.endsWith('/messages')) return json(200, { messages: sc.messages.map((m) => ({ id: m.id })) });
  const mm = p.match(/\/messages\/([^/]+)$/);
  if (mm) { const m = sc.messages.find((x) => x.id === mm[1]); return m ? json(200, m) : json(404, {}); }
  if (p.endsWith('/calendarList')) return json(200, { items: Object.entries(calIds).map(([id, summary]) => ({ id, summary })) });
  const em = p.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (em) {
    const cal = decodeURIComponent(em[1]);
    const list = (sc.events[cal] ??= []);
    if (em[2]) {
      const id = decodeURIComponent(em[2]);
      const ev = list.find((e) => e.id === id);
      if (!ev) return json(404, {});
      if (method === 'DELETE') { sc.events[cal] = list.filter((e) => e.id !== id); return json(204); }
      return json(200, ev);
    }
    if (method === 'POST') { const ev = { id: `ev${seq++}`, ...JSON.parse(String(init!.body)) }; list.push(ev); return json(200, ev); }
    const q = url.searchParams.get('q')?.toLowerCase();
    const tmin = Date.parse(url.searchParams.get('timeMin') ?? '1970-01-01');
    const tmax = Date.parse(url.searchParams.get('timeMax') ?? '2100-01-01');
    const t = (x: any) => Date.parse(x?.dateTime ?? x?.date);
    return json(200, { items: list.filter((e) => (!q || (e.summary + ' ' + (e.description ?? '')).toLowerCase().includes(q)) && t(e.end) > tmin && t(e.start) < tmax) });
  }
  if (p.includes('token')) return json(200, { access_token: 'x', expires_in: 3600 });
  return json(500, {});
}) as typeof fetch;

class Mem implements StateStore { m = new Map(); get(k: string) { return this.m.get(k); } set(k: string, v: any) { this.m.set(k, v); } }
let broker = mkBroker();
function mkBroker() {
  return new GoogleBroker(() => cfg, { token: async () => 't', status: () => ({}) }, new Mem(), fakeFetch, () => Date.parse(sc.now ?? '2026-11-10T20:00:00Z'));
}

const remTools = JSON.parse(fs.readFileSync(path.join(DIR, 'reminders-tools.json'), 'utf8'));
const noteTools = JSON.parse(fs.readFileSync(path.join(DIR, 'notes-tools.json'), 'utf8'));
const ALLOWED = ['Kids', 'Family'];

function reminders(name: string, a: any): string {
  const vis = sc.reminders.filter((r) => ALLOWED.includes(r.list));
  const show = (rs: Rem[]) => JSON.stringify({ status: 'ok', items: rs.map((r) => ({ id: r.id, title: r.title, list: r.list, due: r.due ?? null, completed: !!r.completed, notes: r.notes ?? null })) });
  switch (name) {
    case 'reminders_health': return '{"status":"authorized"}';
    case 'reminder_lists': return JSON.stringify({ status: 'ok', items: ALLOWED.map((t) => ({ title: t, writable: true })) });
    case 'reminders_in_list':
      if (!ALLOWED.includes(a.list_name)) throw new Error(`list ${a.list_name} is not available to this caller`);
      return show(vis.filter((r) => r.list === a.list_name && (a.include_completed || !r.completed)));
    case 'search_reminders': return show(vis.filter((r) => r.title.toLowerCase().includes(String(a.query).toLowerCase())));
    case 'reminders_today': case 'reminders_upcoming': case 'reminders_overdue': return show(vis.filter((r) => r.due && !r.completed));
    case 'reminder_info': { const r = vis.find((x) => x.id === a.eventkit_id); if (!r) throw new Error('not found'); return show([r]); }
    case 'add_reminder': {
      if (!ALLOWED.includes(a.list_name)) throw new Error(`list ${a.list_name} is not available to this caller`);
      const r: Rem = { id: `rem${seq++}`, title: a.title, list: a.list_name, due: a.due, notes: a.notes };
      sc.reminders.push(r); return JSON.stringify({ status: 'ok', id: r.id, title: r.title, list: r.list });
    }
    case 'delete_reminder': case 'complete_reminder': {
      const r = vis.find((x) => x.id === a.eventkit_id); if (!r) throw new Error('not found');
      r.completed = true; return JSON.stringify({ status: 'ok', id: r.id, completed: true });
    }
    default: return JSON.stringify({ status: 'ok' });
  }
}

async function mcp(server: string, req: any): Promise<object | null> {
  if (req.id === undefined) return null;
  const ok = (result: object) => ({ jsonrpc: '2.0', id: req.id, result });
  if (server === 'google') {
    const out = (await handleRpc(broker, 'family', req)) as any;
    if (req.method === 'tools/call') rec('google', req.params.name, req.params.arguments, out.result.content[0].text);
    return out;
  }
  if (req.method === 'initialize') return ok({ protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: server, version: '0' } });
  if (req.method === 'tools/list') return ok({ tools: server === 'reminders' ? remTools : noteTools });
  if (req.method === 'tools/call') {
    const { name, arguments: a } = req.params;
    try {
      const text = server === 'reminders' ? reminders(name, a ?? {}) : JSON.stringify({ status: 'ok', notes: [] });
      rec(server, name, a, text);
      return ok({ content: [{ type: 'text', text }] });
    } catch (e) { rec(server, name, a, 'ERROR ' + (e as Error).message); return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true }); }
  }
  return ok({});
}

http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const send = (s: number, b?: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
  const u = req.url ?? '';
  if (u === '/admin/scenario' && req.method === 'POST') { sc = JSON.parse(raw); sc.events ??= {}; sc.reminders ??= []; sc.messages ??= []; calls = []; broker = mkBroker(); return send(200, { ok: true }); }
  if (u === '/admin/calls') { const c = calls; calls = []; return send(200, { calls: c, events: sc.events, reminders: sc.reminders }); }
  const m = u.match(/^\/(google|reminders|notes)\/mcp$/);
  if (!m || req.method !== 'POST') return send(404);
  const out = await mcp(m[1], JSON.parse(raw));
  return out ? send(200, out) : send(202);
}).listen(8799, '127.0.0.1', () => console.log('mock-family on 127.0.0.1:8799'));
