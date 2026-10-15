#!/usr/bin/env node
// TC-UI-14-1: real-LLM smoke test of the dashboard chat agent on a running cluster. Signs in as the seeded
// admin (password read from the Secret, never printed), asks read-only questions through POST /api/chat,
// prints each reply with the tool calls the agent made, and checks the audit log has those calls under
// the admin with source=chat. Read-only on purpose: creating products is UI-19.
// Usage: node scripts/chat-smoke.mjs ["question" ...]   Env: APP_ORIGIN (default http://app.127.0.0.1.nip.io)
import { adminSession } from './lib/gateway-key.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const questions = process.argv.slice(2).length ? process.argv.slice(2)
  : ['What orders came in today?', 'List 3 products from the store with their prices.'];

const cookie = await adminSession();
const started = new Date();
const api = (method, path, body) => fetch(`${ORIGIN}${path}`, {
  method, headers: { origin: ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

let failures = 0;
let made = 0;
for (const q of questions) {
  const t = Date.now();
  const res = await api('POST', '/api/chat', { messages: [{ role: 'user', content: q }] });
  const body = await res.json();
  console.log(`\n> ${q}\nHTTP ${res.status} in ${Date.now() - t} ms${body.stopped ? `, stopped=${body.stopped}` : ''}`);
  if (!res.ok) { console.log(`FAIL  ${body.error}: ${body.message}`); failures++; continue; }
  for (const c of body.toolCalls) console.log(`  tool ${c.name} ${JSON.stringify(c.args)} → ${c.ok ? 'ok' : 'error'} (${c.ms} ms) ${c.resultPreview.slice(0, 120).replace(/\s+/g, ' ')}`);
  console.log(`  reply: ${body.reply.slice(0, 600)}`);
  if (body.toolCalls.length === 0) { console.log('FAIL  no tool was called'); failures++; }
  made += body.toolCalls.filter((c) => c.server).length; // find_tools runs in the agent, not through /mcp
}

const me = await (await api('GET', '/api/me')).json();
const audit = await (await api('GET', `/api/audit?source=chat&from=${encodeURIComponent(started.toISOString())}&limit=100`)).json();
const rows = (audit.items ?? audit.rows ?? audit).filter?.((r) => r.method === 'tools/call') ?? [];
const mine = rows.filter((r) => (r.user?.id ?? r.userId) === me.id);
console.log(`\naudit: ${rows.length} chat tools/call rows since start, ${mine.length} attributed to ${me.email}; agent made ${made} calls`);
if (mine.length < made || mine.length !== rows.length) { console.log('FAIL  audit attribution'); failures++; }
console.log(failures ? `FAIL  TC-UI-14-1 (${failures})` : 'PASS  TC-UI-14-1');
process.exit(failures ? 1 : 0);
