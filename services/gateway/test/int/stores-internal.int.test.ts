// TC-BON-09-3 (D-026): the provisioner's signed internal API and its read-only DB role, with real Postgres.
// Unsigned, forged, stale and re-pointed requests are refused; ready registers the store's own woo-mcp only
// (encrypted token, owner-scoped, members read-only); every call is idempotent; the provisioner role can read
// only the listed `stores` columns.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { decryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { stores, users } from '../../src/db/schema.js';
import { setProvisionerPassword } from '../../src/stores/db-role.js';
import { registerInternalStoreRoutes } from '../../src/stores/internal.js';
import { sign, SIGNATURE_HEADER } from '../../src/stores/signing.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_stores_${randomUUID().slice(0, 8)}`;
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const signingKey = randomBytes(32);
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let ownerId: string;

const TOKEN = 'T'.repeat(48);
const ready = (slug: string) => ({ wooMcpUrl: `http://woo-mcp.store-${slug}.svc.cluster.local/mcp`, wooMcpToken: TOKEN, adminUser: 'storeadmin', adminPassword: 'P'.repeat(24) });
async function call(path: string, body: object, opts: { key?: Buffer; sigPath?: string; when?: number; header?: string | null } = {}) {
  const raw = JSON.stringify(body);
  const sig = opts.header === null ? undefined : opts.header ?? sign(opts.key ?? signingKey, 'POST', opts.sigPath ?? path, raw, opts.when);
  return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': 'application/json', ...(sig ? { [SIGNATURE_HEADER]: sig } : {}) } });
}
async function newStore(slug: string, status: 'provisioning' | 'deleting' = 'provisioning') {
  const [s] = await db.insert(stores).values({ slug, name: `Store ${slug}`, niche: 'tea-coffee', ownerId, requestKey: `req-${slug}-0001`, status,
    desired: status === 'deleting' ? 'absent' : 'present' }).returning();
  return s!;
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const [u] = await db.insert(users).values({ email: 'owner@example.test', name: 'Owner', passwordHash: await hashPassword('owner-test-password') }).returning({ id: users.id });
  ownerId = u!.id;
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  registerInternalStoreRoutes(app, { db, key, signingKey });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('DELETE FROM upstreams'); await pool.query('DELETE FROM stores');
});

describe('TC-BON-09-3 signed internal API', () => {
  it('unsigned, wrong key, stale, re-pointed and tampered requests → 401; nothing changes', async () => {
    const s = await newStore('tea');
    const path = `/internal/stores/${s.id}/ready`;
    const other = await newStore('cof');
    for (const res of [
      await call(path, ready('tea'), { header: null }),
      await call(path, ready('tea'), { key: randomBytes(32) }),
      await call(path, ready('tea'), { when: Date.now() - 120_000 }),
      await call(path, ready('tea'), { sigPath: `/internal/stores/${other.id}/ready` }), // signature for another store
      await call(path, ready('tea'), { header: 't=1,v1=' + '0'.repeat(64) }),
    ]) expect(res.statusCode).toBe(401);
    // A valid signature over a different body does not cover this one.
    const raw = JSON.stringify(ready('tea'));
    const res = await app.inject({ method: 'POST', url: path, payload: raw.replace('storeadmin', 'evil'),
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(signingKey, 'POST', path, raw) } });
    expect(res.statusCode).toBe(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM upstreams')).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT status FROM stores WHERE id = $1`, [s.id])).rows[0].status).toBe('provisioning');
  });

  it('ready registers only this store\'s woo-mcp: encrypted token, owner-scoped, members read-only; idempotent', async () => {
    const s = await newStore('tea');
    const path = `/internal/stores/${s.id}/ready`;
    for (const url of ['http://woo-mcp.store-cof.svc.cluster.local/mcp', 'http://evil.example/mcp', 'http://woo-mcp.store.svc.cluster.local/mcp', 'https://woo-mcp.store-tea.svc.cluster.local/mcp']) {
      expect((await call(path, { ...ready('tea'), wooMcpUrl: url })).statusCode, url).toBe(400);
    }
    expect((await call(path, ready('tea'))).statusCode).toBe(200);
    expect((await call(path, ready('tea'))).statusCode).toBe(200); // retried after a restart
    const { rows } = await pool.query('SELECT slug, url, auth_type, credential_enc, member_access, member_tools, store_id, created_by FROM upstreams');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'woo-tea', url: 'http://woo-mcp.store-tea.svc.cluster.local/mcp', auth_type: 'bearer', member_access: 'selected',
      member_tools: ['list_products', 'list_orders', 'get_order'], store_id: s.id, created_by: ownerId });
    expect(JSON.stringify(rows[0].credential_enc)).not.toContain(TOKEN);
    expect(decryptCredential(key, 'woo-tea', rows[0].credential_enc)).toBe(TOKEN);
    const st = (await pool.query('SELECT status, admin_password_enc FROM stores WHERE id = $1', [s.id])).rows[0];
    expect(st.status).toBe('ready');
    expect(JSON.stringify(st.admin_password_enc)).not.toContain('PPPP');
  });

  it('failed keeps a short printable reason and never overrides a decision; deleted only while deleting', async () => {
    const s = await newStore('tea');
    expect((await call(`/internal/stores/${s.id}/failed`, { reason: 'timed out\u0000‮ after 15 min' })).statusCode).toBe(200);
    expect((await pool.query('SELECT status, status_reason FROM stores WHERE id = $1', [s.id])).rows[0]).toEqual({ status: 'failed', status_reason: 'timed out   after 15 min' });
    expect((await call(`/internal/stores/${s.id}/ready`, ready('tea'))).statusCode).toBe(409); // failed stays failed
    expect((await call(`/internal/stores/${s.id}/deleted`, {})).statusCode).toBe(409); // not being deleted
    const d = await newStore('del', 'deleting');
    expect((await call(`/internal/stores/${d.id}/deleted`, {})).json()).toEqual({ status: 'deleted' });
    expect((await call(`/internal/stores/${d.id}/deleted`, {})).statusCode).toBe(200);
  });
});

describe('TC-BON-09-3b provisioner DB role', () => {
  it('logs in, reads the listed stores columns, and nothing else', async () => {
    const password = randomBytes(24).toString('base64url');
    await setProvisionerPassword(pool, password);
    await newStore('tea');
    const p = new pg.Client({ ...base, database: dbName, user: 'provisioner', password });
    await p.connect();
    try {
      const { rows } = await p.query('SELECT id, slug, name, tagline, niche, niche_text, status, desired, created_at FROM stores');
      expect(rows.map((r) => r.slug)).toEqual(['tea']);
      for (const q of ['SELECT admin_password_enc FROM stores', 'SELECT * FROM stores', 'SELECT id FROM users', 'SELECT id FROM upstreams', 'SELECT id FROM api_keys',
        "UPDATE stores SET status = 'ready'", 'DELETE FROM stores', "INSERT INTO store_members (store_id, user_id) VALUES (gen_random_uuid(), gen_random_uuid())"]) {
        await expect(p.query(q), q).rejects.toThrow(/permission denied/);
      }
    } finally {
      await p.end();
    }
    await expect(setProvisionerPassword(pool, "x'; DROP TABLE users; --")).rejects.toThrow(/must be/);
  });
});
