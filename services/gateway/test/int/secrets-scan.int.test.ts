// TC-AUTH-04 (AUTH-15): drive every /api route (from the live route table) and /mcp with known secret
// values in play, capture every response body and every log line, and assert that none of the secrets
// appears anywhere. Secrets: admin + member passwords, an invite token, API keys (one revoked), the
// encrypted upstream credential, the credentials encryption key, and stored hashes.
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { accessTable } from '../../src/auth/access.js';
import { authenticateApiKey } from '../../src/auth/api-keys.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { encryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { upstreams } from '../../src/db/schema.js';
import { loggerOptions } from '../../src/logger.js';
import { registerMcp } from '../../src/mcp/route.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';
import { ssrfPolicy } from '../../src/upstreams/ssrf.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_scan_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const ADMIN_PW = `admin-pw-${randomBytes(8).toString('hex')}`;
const MEMBER_PW = `member-pw-${randomBytes(8).toString('hex')}`;
const UPSTREAM_TOKEN = `upstream-token-${randomBytes(12).toString('hex')}`;
const CRED_KEY_HEX = randomBytes(32).toString('hex');
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let fake: FakeUpstream;
const logs: string[] = [];
const bodies: string[] = [];
const secrets: string[] = [ADMIN_PW, MEMBER_PW, UPSTREAM_TOKEN, CRED_KEY_HEX];

async function call(method: string, url: string, opts: { cookie?: string; payload?: object; bearer?: string } = {}) {
  const res = await app.inject({ method: method as 'GET', url, payload: opts.payload,
    headers: { origin: ORIGIN, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(url === '/mcp' ? { accept: 'application/json, text/event-stream' } : {}) } });
  bodies.push(`${method} ${url} → ${res.statusCode}\n${res.body}`);
  return res;
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: ADMIN_PW });
  const key = loadCredentialKey({ CREDENTIALS_KEY: CRED_KEY_HEX });
  fake = await startFakeUpstream({ tools: ['echo', 'boom'] });
  await db.insert(upstreams).values({ slug: 'woo', name: 'Woo', url: fake.url, authType: 'bearer', credentialEnc: encryptCredential(key, 'woo', UPSTREAM_TOKEN) });

  const stream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  app = buildApp(loadConfig({}), { logger: { ...loggerOptions('debug'), stream } }); // debug: the most verbose level we ship
  await registerAuth(app, { db, cookieSecure: true, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 2_000, log: app.log });
  const health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db) });
  const discovery = new ToolDiscovery(upstreamPool, { listTimeoutMs: 3_000, log: app.log, health });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, discovery, health, key, ssrf: ssrfPolicy(['127.0.0.1']) });
  registerMcp(app, { authenticate: (t) => authenticateApiKey(db, t), loadUpstreams: () => listUpstreams(db), pool: upstreamPool,
    discovery, health, audit: dbAuditSink(db, app.log) });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await upstreamPool?.close();
  await fake?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('TC-AUTH-04 no secret in any /api or /mcp response, nor in any log line (AUTH-15)', () => {
  it('full flow: login, invite, accept, keys, /mcp calls, revoke, audit, plus every route anonymously and as member', async () => {
    const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
    const adminCookie = cookieOf(await call('POST', '/api/auth/login', { payload: { email: 'admin@example.test', password: ADMIN_PW } }));
    await call('POST', '/api/auth/login', { payload: { email: 'admin@example.test', password: `${ADMIN_PW}-wrong` } });

    const inv = (await call('POST', '/api/invites', { cookie: adminCookie, payload: { email: 'member@example.test' } })).json();
    const inviteToken = inv.inviteUrl.split('#')[1];
    bodies.pop(); // creating the invite is the one response that shows its link (shown once, like a new key)
    await call('GET', '/api/invites', { cookie: adminCookie });
    await call('POST', '/api/invites/check', { payload: { token: inviteToken } });
    const acc = await call('POST', '/api/invites/accept', { payload: { token: inviteToken, name: 'Member', password: MEMBER_PW } });
    const memberCookie = cookieOf(acc);
    await call('POST', '/api/invites/accept', { payload: { token: inviteToken, name: 'Again', password: MEMBER_PW } });
    secrets.push(inviteToken);

    const k1 = (await call('POST', '/api/keys', { cookie: memberCookie, payload: { name: 'laptop' } })).json();
    const k2 = (await call('POST', `/api/users/${acc.json().user.id}/keys`, { cookie: adminCookie, payload: { name: 'issued' } })).json();
    // The one response allowed to contain a key is the one that creates it: drop those two bodies.
    bodies.splice(bodies.length - 2, 2);
    secrets.push(k1.key, k2.key, k1.key.slice(12), k2.key.slice(12));
    await call('GET', '/api/keys', { cookie: memberCookie });
    await call('GET', '/api/keys?all=1', { cookie: adminCookie });
    await call('GET', '/api/me', { cookie: memberCookie });

    const rpc = (id: number, method: string, params?: object) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    await call('POST', '/mcp', { bearer: k1.key, payload: rpc(1, 'tools/list') });
    await call('POST', '/mcp', { bearer: k1.key, payload: rpc(2, 'tools/call', { name: 'woo__echo', arguments: { note: `pass ${MEMBER_PW}` } }) });
    bodies.pop(); // the echo tool returns its arguments to the caller by design; the log is what matters here
    await call('POST', '/mcp', { bearer: k1.key, payload: rpc(3, 'tools/call', { name: 'woo__boom', arguments: {} }) });
    await call('POST', '/mcp', { bearer: `${k1.key}x`, payload: rpc(4, 'tools/list') });
    await call('DELETE', `/api/keys/${k1.id}`, { cookie: memberCookie });
    await call('POST', '/mcp', { bearer: k1.key, payload: rpc(5, 'tools/list') });
    await call('GET', '/api/audit', { cookie: adminCookie });
    const ups = (await call('GET', '/api/upstreams', { cookie: adminCookie })).json();
    await call('GET', '/api/upstreams', { cookie: memberCookie });
    await call('GET', `/api/upstreams/${ups[0].id}/tools`, { cookie: memberCookie });
    // Admin adds a server with a credential, rotates it, switches to a custom header, then removes it.
    const NEW_TOKEN = `added-server-token-${randomBytes(6).toString('hex')}`;
    const ROTATED = `rotated-server-token-${randomBytes(6).toString('hex')}`;
    const added = (await call('POST', '/api/upstreams', { cookie: adminCookie,
      payload: { name: 'Added', slug: 'added', url: fake.url, authType: 'bearer', credential: NEW_TOKEN } })).json();
    await call('PATCH', `/api/upstreams/${added.id}`, { cookie: adminCookie, payload: { credential: ROTATED } });
    await call('PATCH', `/api/upstreams/${added.id}`, { cookie: adminCookie, payload: { authType: 'header', authHeader: 'X-Api-Key' } });
    await call('POST', '/mcp', { bearer: k2.key, payload: rpc(6, 'tools/list') });
    await call('GET', '/api/upstreams', { cookie: adminCookie });
    await call('DELETE', `/api/upstreams/${added.id}`, { cookie: adminCookie });
    secrets.push(NEW_TOKEN, ROTATED);

    // Every registered route, anonymous and as member, with an empty body.
    for (const r of accessTable(app)) {
      const url = r.url.replace(/:[a-z]+/g, randomUUID());
      const payload = r.method === 'GET' || r.method === 'DELETE' ? undefined : {};
      await call(r.method, url, { payload });
      await call(r.method, url, { cookie: memberCookie, payload });
    }
    await call('POST', '/api/auth/logout', { cookie: memberCookie });

    // Stored hashes count as secrets too: they must never leave the server.
    for (const row of (await pool.query('SELECT key_hash FROM api_keys UNION ALL SELECT id_hash FROM sessions UNION ALL SELECT token_hash FROM invites UNION ALL SELECT password_hash FROM users')).rows) {
      secrets.push(Object.values(row)[0] as string);
    }
    const ct = (await pool.query(`SELECT credential_enc->>'ciphertext' AS c FROM upstreams`)).rows[0].c as string;
    secrets.push(ct);

    expect(bodies.length).toBeGreaterThan(30);
    expect(logs.length).toBeGreaterThan(30);
    const out = bodies.join('\n');
    const log = logs.join('');
    const kinds = ['admin password', 'member password', 'upstream token', 'credentials key', 'invite token', 'key 1', 'key 2', 'key 1 secret part', 'key 2 secret part', 'added upstream token', 'rotated upstream token'];
    for (const [i, s] of secrets.entries()) {
      const hit = bodies.find((b) => b.includes(s));
      if (hit) console.error(`LEAK ${kinds[i] ?? `stored value #${i}`} in: ${hit.split('\n')[0]} :: ${hit.slice(0, 300).replace(s, '<SECRET>')}`);
      expect(out.includes(s), `secret …${s.slice(-6)} in a response`).toBe(false);
      expect(log.includes(s), `secret …${s.slice(-6)} in the log`).toBe(false);
    }
    // The upstream did get its credential (proves the token was really in play), the client never did.
    expect(fake.headers.some((h) => h.authorization === `Bearer ${UPSTREAM_TOKEN}`)).toBe(true);
  });
});
