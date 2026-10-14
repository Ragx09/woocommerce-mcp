// TC-AUTH-02 (AUTH-10): every /api route, as registered — not a hand-written list — is tested for
// anonymous, member and admin access. New routes are covered automatically; a route without an access
// policy cannot even be registered.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { accessTable, enforceAccessPolicy } from '../../src/auth/access.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_authz_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'authz-test-password';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let memberCookie: string;
let adminCookie: string;

/** Routes reachable without a session — on purpose. Adding one must be a conscious change here. */
const PUBLIC = ['POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/invites/check', 'POST /api/invites/accept'];

const concrete = (url: string) => url.replace(/:[a-z]+/g, randomUUID());
const call = (method: string, url: string, cookie?: string) =>
  app.inject({ method: method as 'GET', url: concrete(url), headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  await db.insert(users).values({ email: 'member@example.test', name: 'M', passwordHash: await hashPassword(PW) });
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  // Every module that adds /api routes is registered here, so the table below covers all of them.
  const upstreamPool = new UpstreamPool({ key: loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') }) });
  const health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db) });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, health, discovery: new ToolDiscovery(upstreamPool, { health }) });
  await app.ready();
  const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
    payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  memberCookie = await login('member@example.test');
  adminCookie = await login('admin@example.test');
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('TC-AUTH-02 server-side authorization over every /api route (AUTH-10)', () => {
  it('the route table has every route, and the public ones are exactly the intended list', () => {
    const table = accessTable(app);
    expect(table.length).toBeGreaterThanOrEqual(11);
    expect(table.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.url}`).sort()).toEqual([...PUBLIC].sort());
    expect(table.filter((r) => r.access === 'admin').map((r) => `${r.method} ${r.url}`).sort())
      .toEqual(['DELETE /api/invites/:id', 'DELETE /api/upstreams/:id', 'GET /api/audit', 'GET /api/invites', 'GET /api/users',
        'PATCH /api/upstreams/:id', 'PATCH /api/users/:id', 'POST /api/invites', 'POST /api/upstreams', 'POST /api/users/:id/keys']);
  });

  it('anonymous → 401 on every non-public route, before the body is even validated', async () => {
    for (const r of accessTable(app).filter((x) => x.access !== 'public')) {
      const res = await call(r.method, r.url);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(res.json(), `${r.method} ${r.url}`).toEqual({ error: 'unauthenticated', message: 'log in first' });
    }
  });

  it('member → 403 on every admin route; admin passes the guard', async () => {
    const adminRoutes = accessTable(app).filter((x) => x.access === 'admin');
    for (const r of adminRoutes) {
      const m = await call(r.method, r.url, memberCookie);
      expect(m.statusCode, `member ${r.method} ${r.url}`).toBe(403);
      expect(m.json()).toEqual({ error: 'forbidden', message: 'not allowed for your role' });
      const a = await call(r.method, r.url, adminCookie);
      expect([401, 403], `admin ${r.method} ${r.url} → ${a.statusCode}`).not.toContain(a.statusCode);
    }
  });

  it('member passes the guard on every session route', async () => {
    for (const r of accessTable(app).filter((x) => x.access === 'session')) {
      const res = await call(r.method, r.url, memberCookie);
      expect([401, 403], `member ${r.method} ${r.url} → ${res.statusCode}`).not.toContain(res.statusCode);
    }
  });

  it('a route without an access policy cannot be registered (default deny)', async () => {
    const other = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
    enforceAccessPolicy(other, db);
    expect(() => other.get('/api/forgot-the-guard', async () => ({ secret: true }))).toThrow(/needs config.access/);
    other.get('/not-api', async () => ({})); // outside /api: not affected
    await other.close();
  });
});
