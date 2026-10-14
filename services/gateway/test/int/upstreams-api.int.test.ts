// TC-UI-04-API (UI-04, REQ-GW-09/10): GET /api/upstreams shows every registered server with its status
// (connected / unreachable / disabled), last error and tool count; GET /api/upstreams/:id/tools lists
// its tools. Real Postgres, in-process fake upstreams, the real health monitor.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { encryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { upstreams, users } from '../../src/db/schema.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams, setUpstreamEnabled } from '../../src/upstreams/repo.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_upapi_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'upstreams-api-password';
const TOKEN = `secret-upstream-token-${randomBytes(8).toString('hex')}`;
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let health: HealthMonitor;
let woo: FakeUpstream;
let ev: FakeUpstream;
let adminCookie: string;
let memberCookie: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  await db.insert(users).values({ email: 'member@example.test', name: 'M', passwordHash: await hashPassword(PW) });
  const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
  woo = await startFakeUpstream({ tools: ['list_orders', 'get_order', 'create_product'] });
  ev = await startFakeUpstream({ tools: ['echo'], sessionful: true });
  for (const [slug, url, extra] of [
    ['woo', woo.url, { authType: 'bearer' as const, credentialEnc: encryptCredential(key, 'woo', TOKEN) }],
    ['everything', ev.url, {}],
    ['off', 'http://127.0.0.1:9/mcp', { enabled: false }],
  ] as const) {
    const [r] = await db.insert(upstreams).values({ slug, name: slug.toUpperCase(), url, ...extra }).returning();
    ids[slug] = r!.id;
  }
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db), checkTimeoutMs: 1_000 });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, health, discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 1_000, health }) });
  await app.ready();
  const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
    payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  adminCookie = await login('admin@example.test');
  memberCookie = await login('member@example.test');
});
afterAll(async () => {
  await app?.close();
  await health?.stop();
  await upstreamPool?.close();
  await woo?.close();
  await ev?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const get = (url: string, cookie = adminCookie) => app.inject({ method: 'GET', url, headers: { cookie } });
const bySlug = async (cookie = adminCookie) =>
  Object.fromEntries(((await get('/api/upstreams', cookie)).json() as { slug: string }[]).map((u) => [u.slug, u])) as Record<string, Record<string, unknown>>;

describe('TC-UI-04-API server list and tools (UI-04)', () => {
  it('admin: registry order, status per server, tool counts, credentials never shown', async () => {
    await health.checkAll();
    const res = await get('/api/upstreams');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain('ciphertext');
    const list = res.json() as Record<string, unknown>[];
    expect(list.map((u) => u.slug)).toEqual(['woo', 'everything', 'off']);
    expect(list[0]).toMatchObject({ name: 'WOO', enabled: true, status: 'connected', lastError: null, toolCount: 3,
      url: woo.url, authType: 'bearer', hasCredential: true });
    expect(list[0]!.lastCheckedAt).toEqual(expect.any(String));
    expect(list[1]).toMatchObject({ status: 'connected', toolCount: 1 });
    expect(list[2]).toMatchObject({ status: 'disabled', enabled: false, toolCount: null });
    expect(list[0]).not.toHaveProperty('credentialEnc');
  });

  it('member: same servers and status, without URL or auth details', async () => {
    const u = await bySlug(memberCookie);
    expect(Object.keys(u)).toEqual(['woo', 'everything', 'off']);
    expect(u.woo).toMatchObject({ status: 'connected', toolCount: 3 });
    for (const k of ['url', 'authType', 'authHeader', 'hasCredential']) expect(u.woo).not.toHaveProperty(k);
  });

  it('tools of one server: public names, descriptions, parameters', async () => {
    const res = await get(`/api/upstreams/${ids.woo}/tools`, memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['list_orders', 'get_order', 'create_product'].map((n) => ({
      publicName: `woo__${n}`, name: n, title: null, description: `fake ${n}`, params: [],
    })));
    expect((await get(`/api/upstreams/${ids.off}/tools`)).json()).toMatchObject({ error: 'upstream_disabled' });
    expect((await get(`/api/upstreams/${randomUUID()}/tools`)).statusCode).toBe(404);
    expect((await get('/api/upstreams/not-a-uuid/tools')).statusCode).toBe(400);
  });

  it('kill one server → Unreachable with a safe last error, the others unaffected; back → Connected', async () => {
    const port = Number(new URL(ev.url).port);
    await ev.close();
    await health.checkAll();
    let u = await bySlug();
    expect(u.everything).toMatchObject({ status: 'unreachable', toolCount: null });
    expect(String(u.everything!.lastError)).toMatch(/^upstream everything unreachable/);
    expect(String(u.everything!.lastError)).not.toContain('127.0.0.1');
    expect(u.woo).toMatchObject({ status: 'connected', toolCount: 3 });
    const t = await get(`/api/upstreams/${ids.everything}/tools`);
    expect([t.statusCode, t.json().error]).toEqual([502, 'upstream_unreachable']);

    ev = await startFakeUpstream({ tools: ['echo', 'add'], sessionful: true, port });
    await health.checkAll();
    u = await bySlug();
    expect(u.everything).toMatchObject({ status: 'connected' });
    expect(String(u.everything!.lastError)).toMatch(/unreachable/); // last problem kept for the dashboard
  });

  it('disable / enable is visible on the next request', async () => {
    await setUpstreamEnabled(db, ids.woo!, false);
    expect((await bySlug()).woo).toMatchObject({ status: 'disabled', toolCount: null });
    await setUpstreamEnabled(db, ids.woo!, true);
    expect((await bySlug()).woo).toMatchObject({ enabled: true, toolCount: 3 });
  });

  it('anonymous → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/upstreams' })).statusCode).toBe(401);
  });
});
