#!/usr/bin/env node
// E2E-03 (REQ-DOD-12): the two demo users.
//   A = the seeded admin (Secret platform/gateway-admin) — uses the dashboard chat.
//   B = a member, created through the normal invite flow (admin invites → B accepts) — uses an external
//       MCP client with B's own API key.
// B's password lives only in Secret platform/demo-users (generated on first run, or DEMO_B_PASSWORD);
// it is never printed or committed. Idempotent: an existing, enabled B is left alone; a disabled B is enabled.
//
//   node scripts/seed-demo-users.mjs          # ensure A and B exist and can sign in
//   node scripts/seed-demo-users.mjs --key    # also create a key for B and print it ONCE (for Claude Code / Inspector)
//
// Env: APP_ORIGIN (default http://app.127.0.0.1.nip.io), DEMO_B_EMAIL (default priya@tatva.shop),
//      DEMO_B_PASSWORD (only used when the Secret does not exist yet), KUBECTL_CONTEXT (optional).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { adminSession } from './lib/gateway-key.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const ctx = process.env.KUBECTL_CONTEXT ? ['--context', process.env.KUBECTL_CONTEXT] : [];
const kubectl = (args, input) => execFileSync('kubectl', [...ctx, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

async function api(method, path, { cookie, body } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

/** B's credentials from Secret platform/demo-users; created (random 24-char password) when missing. */
function userBSecret() {
  try {
    const d = JSON.parse(kubectl(['-n', 'platform', 'get', 'secret', 'demo-users', '-o', 'json'])).data;
    return { email: Buffer.from(d['b-email'], 'base64').toString(), password: Buffer.from(d['b-password'], 'base64').toString() };
  } catch (e) {
    if (!/NotFound/.test(String(e.stderr ?? e.message))) throw e;
  }
  const email = process.env.DEMO_B_EMAIL ?? 'priya@tatva.shop';
  const password = process.env.DEMO_B_PASSWORD ?? randomBytes(18).toString('base64url');
  const manifest = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: 'demo-users', namespace: 'platform' },
    stringData: { 'b-email': email, 'b-password': password } };
  kubectl(['apply', '-f', '-'], JSON.stringify(manifest)); // via stdin: the password never appears in a process list
  return { email, password };
}

/** Ensures A and B; returns { a: {cookie, user}, b: {cookie, user, email} }. */
export async function ensureDemoUsers() {
  const aCookie = await adminSession();
  const a = (await api('GET', '/api/me', { cookie: aCookie })).body;
  const { email, password } = userBSecret();

  const users = (await api('GET', '/api/users', { cookie: aCookie })).body;
  let bUser = users.find((u) => u.email === email);
  if (!bUser) {
    const inv = await api('POST', '/api/invites', { cookie: aCookie, body: { email, role: 'member' } });
    if (inv.status !== 201) throw new Error(`invite for B → ${inv.status} ${JSON.stringify(inv.body)}`);
    const token = new URL(inv.body.inviteUrl).hash.slice(1);
    const acc = await api('POST', '/api/invites/accept', { body: { token, name: 'Rajini', password } });
    if (acc.status !== 201) throw new Error(`B accepting the invite → ${acc.status} ${JSON.stringify(acc.body)}`);
    console.log(`created  user B ${email} (member) through the invite flow`);
    bUser = (await api('GET', '/api/users', { cookie: aCookie })).body.find((u) => u.email === email);
  } else if (bUser.disabledAt) {
    await api('PATCH', `/api/users/${bUser.id}`, { cookie: aCookie, body: { disabled: false } });
    console.log(`enabled  user B ${email}`);
  }
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`B cannot sign in (${login.status}); the password in Secret platform/demo-users does not match the account`);
  return { a: { cookie: aCookie, user: a }, b: { cookie: login.cookie, user: login.body.user, email } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { a, b } = await ensureDemoUsers();
  console.log(`ok       user A ${a.user.email} (${a.user.role}) signs in`);
  console.log(`ok       user B ${b.email} (${b.user.role}) signs in; password in Secret platform/demo-users (key b-password)`);
  if (process.argv.includes('--key')) {
    const k = await api('POST', '/api/keys', { cookie: b.cookie, body: { name: `B external client ${new Date().toISOString().slice(0, 10)}` } });
    if (k.status !== 201) throw new Error(`creating B's key → ${k.status}`);
    console.log(`\nB's API key (shown once, not stored anywhere else; revoke it in the dashboard → API keys):\n${k.body.key}`);
  }
}
