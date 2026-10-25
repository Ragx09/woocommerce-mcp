// Shared helpers for the live security tests. Users: A = seeded admin, B = demo member (scripts/seed-demo-users.mjs).
// Env: APP_ORIGIN (default http://app.127.0.0.1.nip.io), STORE_ORIGIN (default http://store.127.0.0.1.nip.io).
import { randomBytes } from 'node:crypto';
import { ensureDemoUsers } from '../../scripts/seed-demo-users.mjs';

export const APP = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
export const STORE = process.env.STORE_ORIGIN ?? 'http://store.127.0.0.1.nip.io';
export const ZERO_ID = '00000000-0000-4000-8000-000000000000';
export const rand = (n = 6) => randomBytes(n).toString('hex');

let users;
/**
 * { a: {cookie, user}, b: {cookie, user, email} } — logged in once per test file. On a cluster the demo users come from
 * scripts/seed-demo-users.mjs (kubectl). Without a cluster (a gateway started by hand) set SEC_ADMIN_EMAIL,
 * SEC_ADMIN_PASSWORD, SEC_MEMBER_EMAIL, SEC_MEMBER_PASSWORD and they are signed in directly.
 */
export async function demoUsers() {
  if (users) return users;
  const e = process.env;
  if (e.SEC_ADMIN_EMAIL) {
    const login = async (email, password) => {
      const r = await api('POST', '/api/auth/login', { body: { email, password } });
      if (r.status !== 200) throw new Error(`login ${email} → ${r.status}`);
      return { cookie: r.cookie, user: r.body.user, email };
    };
    users = { a: await login(e.SEC_ADMIN_EMAIL, e.SEC_ADMIN_PASSWORD), b: await login(e.SEC_MEMBER_EMAIL, e.SEC_MEMBER_PASSWORD) };
  } else {
    users = await ensureDemoUsers();
  }
  return users;
}

/** A second throwaway member (invited by the admin, accepted, signed in): needed for cross-user (IDOR) attacks. Disabled by the cleanup it returns. */
export async function extraMember(adminCookie, prefix = 'secc') {
  const email = `${prefix}-${rand(4)}@example.invalid`;
  const password = `${prefix}-${rand(10)}-pw`;
  const inv = await api('POST', '/api/invites', { cookie: adminCookie, body: { email } });
  if (inv.status !== 201) throw new Error(`invite → ${inv.status}`);
  const acc = await api('POST', '/api/invites/accept', { body: { token: inv.body.inviteUrl.split('#')[1], name: `${prefix} member`, password } });
  if (acc.status !== 201) throw new Error(`accept → ${acc.status}`);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  return { cookie: login.cookie, user: login.body.user, email, disable: () => api('PATCH', `/api/users/${login.body.user.id}`, { cookie: adminCookie, body: { disabled: true } }) };
}

/** Gateway API call. `origin: false` sends no Origin header; any other string replaces it. */
export async function api(method, path, { cookie, body, origin = APP, headers = {} } = {}) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

/** One JSON-RPC request to /mcp with a bearer token (stateless server: no initialize needed). */
export async function mcp(token, method, params, extraHeaders = {}) {
  const res = await fetch(`${APP}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 401 bodies are JSON too; SSE is not used (JSON responses) */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

/** A key for `cookie`'s user, revoked by the returned cleanup. */
export async function tempKey(cookie, name = `sec-test ${rand()}`) {
  const r = await api('POST', '/api/keys', { cookie, body: { name } });
  if (r.status !== 201) throw new Error(`POST /api/keys → ${r.status} ${r.text}`);
  return { ...r.body, revoke: () => api('DELETE', `/api/keys/${r.body.id}`, { cookie }) };
}

/** Newest audit rows (admin) matching a filter. */
export async function auditRows(adminCookie, query = {}) {
  const r = await api('GET', `/api/audit?${new URLSearchParams({ limit: '50', ...query })}`, { cookie: adminCookie });
  if (r.status !== 200) throw new Error(`GET /api/audit → ${r.status}`);
  return r.body.items;
}

export const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
