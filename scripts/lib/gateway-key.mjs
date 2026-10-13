#!/usr/bin/env node
// Temporary gateway API keys for scripts (AUTH-08 removed the shared dev key). Logs in as the seeded
// admin (password from Secret platform/gateway-admin, read with kubectl, never printed), creates a key,
// and revokes it again. The key itself goes to stdout only when asked (`create`), for a script to keep in
// a variable.
//
//   import { withTempKey } from './lib/gateway-key.mjs'; await withTempKey('my-script', async (key) => …)
//   node scripts/lib/gateway-key.mjs create <name>   → prints "<id> <key>"
//   node scripts/lib/gateway-key.mjs revoke <id>
//
// Env: APP_ORIGIN (default http://app.127.0.0.1.nip.io), KUBECTL_CONTEXT (optional).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';

function secret(key) {
  const ctx = process.env.KUBECTL_CONTEXT ? ['--context', process.env.KUBECTL_CONTEXT] : [];
  const b64 = execFileSync('kubectl', [...ctx, '-n', 'platform', 'get', 'secret', 'gateway-admin', '-o', `jsonpath={.data.${key}}`], { encoding: 'utf8' });
  return Buffer.from(b64, 'base64').toString('utf8');
}

async function api(method, path, { cookie, body } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function adminSession() {
  const res = await api('POST', '/api/auth/login', { body: { email: secret('admin-email'), password: secret('admin-password') } });
  return res.headers.get('set-cookie').split(';')[0];
}

export async function createKey(name) {
  const cookie = await adminSession();
  const k = await (await api('POST', '/api/keys', { cookie, body: { name } })).json();
  return { id: k.id, key: k.key, cookie };
}

export async function revokeKey(id, cookie) {
  await api('DELETE', `/api/keys/${id}`, { cookie: cookie ?? await adminSession() });
}

/** Runs fn with a fresh key and always revokes it afterwards. */
export async function withTempKey(name, fn) {
  const { id, key, cookie } = await createKey(`${name} ${new Date().toISOString().slice(0, 16)}`);
  try { return await fn(key); } finally { await revokeKey(id, cookie).catch((e) => console.error(`warning: could not revoke temp key ${id}: ${e.message}`)); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'create') { const k = await createKey(arg ?? 'script'); console.log(`${k.id} ${k.key}`); }
  else if (cmd === 'revoke' && arg) await revokeKey(arg);
  else { console.error('usage: gateway-key.mjs create <name> | revoke <id>'); process.exit(2); }
}
