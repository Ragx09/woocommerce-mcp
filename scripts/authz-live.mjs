#!/usr/bin/env node
// REL-07: live authorization walk against a running gateway (k3d or VPS). Every admin route must answer
// 401 without a session and 403 for a member (user B); a member cannot revoke someone else's key (404);
// session routes refuse anonymous callers; a forged session cookie is refused. Changes nothing when it passes
// (the guards answer before any route work). Usage: node scripts/authz-live.mjs   Env: APP_ORIGIN
import { ensureDemoUsers } from './seed-demo-users.mjs';
const O = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const { a, b } = await ensureDemoUsers();
const ups = await (await fetch(`${O}/api/upstreams`, { headers: { cookie: a.cookie } })).json();
const u = ups[0].id, z = '00000000-0000-4000-8000-000000000000';
const aKeys = await (await fetch(`${O}/api/keys`, { headers: { cookie: a.cookie } })).json();
const aKey = aKeys.find((k) => !k.revokedAt)?.id ?? z;
const r = async (m, p, cookie, body) => (await fetch(`${O}${p}`, { method: m, headers: { origin: O, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).status;
const cases = [
  ['GET', '/api/users'], ['PATCH', `/api/users/${a.user.id}`, { disabled: true }], ['POST', '/api/invites', { email: 'x@example.invalid' }], ['GET', '/api/invites'],
  ['DELETE', `/api/invites/${z}`], ['POST', `/api/users/${b.user.id}/keys`, { name: 'x' }], ['GET', '/api/keys?all=1'], ['GET', '/api/audit'],
  ['POST', '/api/upstreams', { name: 'x', slug: 'x', url: 'https://example.com/mcp', authType: 'none' }], ['PATCH', `/api/upstreams/${u}`, { enabled: false }], ['DELETE', `/api/upstreams/${u}`],
];
let bad = 0;
for (const [m, p, body] of cases) {
  const anon = await r(m, p, null, body), mem = await r(m, p, b.cookie, body);
  const ok = anon === 401 && mem === 403; if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${m} ${p.replace(/[0-9a-f-]{36}/g, ':id')}  anonymous ${anon}, member ${mem}`);
}
const del = await r('DELETE', `/api/keys/${aKey}`, b.cookie);
console.log(`${del === 404 ? 'PASS' : 'FAIL'}  member revokes the admin's key → ${del} (want 404, key untouched)`); if (del !== 404) bad++;
for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/keys'], ['GET', '/api/upstreams'], ['POST', '/api/chat']]) {
  const s = await r(m, p, null, m === 'POST' ? { messages: [{ role: 'user', content: 'x' }] } : undefined);
  console.log(`${s === 401 ? 'PASS' : 'FAIL'}  ${m} ${p} anonymous → ${s}`); if (s !== 401) bad++;
}
const ev = await r('POST', '/api/upstreams', a.cookie.replace(/=.*/, '=forged'), {}); console.log(`${ev === 401 ? 'PASS' : 'FAIL'}  forged session cookie → ${ev}`); if (ev !== 401) bad++;
console.log(bad ? `FAIL  ${bad}` : 'PASS  live authz walk');
process.exit(bad ? 1 : 0);
