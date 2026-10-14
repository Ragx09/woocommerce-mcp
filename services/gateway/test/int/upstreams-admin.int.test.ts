// TC-UI-05-API / TC-UI-06-API / TC-UI-07-API (UI-05..07, REQ-GW-01) and TC-SEC-01 (T-06): admins add,
// edit, disable and remove MCP servers through /api/upstreams. Credentials are write-only and stored
// encrypted; URLs pass the SSRF guard on save and again when the pool connects.
import { randomBytes, randomUUID } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { decryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { upstreams, users } from '../../src/db/schema.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';
import { ssrfPolicy } from '../../src/upstreams/ssrf.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_upadm_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'upstreams-admin-password';
const SECRET = `new-server-token-${randomBytes(8).toString('hex')}`;
const SECRET2 = `rotated-token-${randomBytes(8).toString('hex')}`;
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
// The fakes listen on 127.0.0.1 (allowlisted literal; 2130706434 = 127.0.0.2 is not, like a cluster Service name in production).
// `localhost` is NOT allowlisted: same address, but it must be refused — the check is by host name.
const policy = ssrfPolicy(['127.0.0.1', 'mcp.internal.test']);
const fakeDns = async (host: string): Promise<LookupAddress[]> => {
  const table: Record<string, string> = { 'localhost': '127.0.0.1', 'mcp.internal.test': '127.0.0.1', 'postgres.platform.svc.cluster.local': '10.43.99.1',
    'metadata.google.internal': '169.254.169.254', 'public.example.com': '93.184.215.14' };
  if (!table[host]) throw new Error('ENOTFOUND');
  return [{ address: table[host]!, family: 4 }];
};
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let health: HealthMonitor;
let fake: FakeUpstream;
let adminCookie: string;
let memberCookie: string;
const headersSeen = () => fake.headers.map((h) => h.authorization ?? h['x-api-key'] ?? null);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  await db.insert(users).values({ email: 'member@example.test', name: 'M', passwordHash: await hashPassword(PW) });
  fake = await startFakeUpstream({ tools: ['alpha', 'beta'] });
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 500, ssrf: policy });
  health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db), checkTimeoutMs: 1_000 });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, health, key, ssrf: policy, lookup: fakeDns,
    discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 1_000, health }) });
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
  await fake?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const req = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, payload?: object, cookie = adminCookie) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie }, ...(payload ? { payload } : {}) });
const create = (b: object) => req('POST', '/api/upstreams', { name: 'New', authType: 'none', ...b });
const row = async (id: string) => (await db.select().from(upstreams).where(eq(upstreams.id, id)))[0];
describe('TC-UI-05-API add a server (UI-05)', () => {
  let id: string;
  it('creates, encrypts the credential, never returns it, and the server connects', async () => {
    const res = await create({ name: ' Alpha ', slug: 'alpha', url: fake.url, authType: 'bearer', credential: SECRET });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(SECRET);
    const body = res.json();
    id = body.id;
    expect(body).toMatchObject({ name: 'Alpha', slug: 'alpha', enabled: true, authType: 'bearer', hasCredential: true, url: fake.url });
    expect(body).not.toHaveProperty('credential');
    const r = (await row(id))!;
    expect(JSON.stringify(r.credentialEnc)).not.toContain(SECRET);
    expect(decryptCredential(key, 'alpha', r.credentialEnc!)).toBe(SECRET);
    expect(r.createdBy).toEqual(expect.any(String));
    await health.checkAll();
    const listed = (await req('GET', '/api/upstreams')).json().find((u: { id: string }) => u.id === id);
    expect(listed).toMatchObject({ status: 'connected', toolCount: 2 });
    expect(headersSeen()).toContain(`Bearer ${SECRET}`); // the stored credential is what the upstream gets
  });

  it('validation: duplicate slug 409, bad slug/fields 400, credential rules', async () => {
    expect((await create({ slug: 'alpha', url: fake.url })).statusCode).toBe(409);
    for (const b of [
      { slug: 'Bad Slug', url: fake.url }, { slug: 'x', url: fake.url, authType: 'basic' }, { slug: 'x', url: fake.url, extra: 1 },
      { slug: 'x', url: fake.url, authType: 'bearer' }, // bearer without a credential
      { slug: 'x', url: fake.url, authType: 'none', credential: 'abc' }, // credential without auth
      { slug: 'x', url: fake.url, authType: 'header', credential: 'abc' }, // header without a name
      { slug: 'x', url: fake.url, authType: 'header', authHeader: 'Host', credential: 'abc' }, // reserved header
      { slug: 'x', url: fake.url, authType: 'bearer', credential: 'line\r\nX-Evil: 1' }, // header injection
    ]) {
      const res = await create(b);
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
    }
    expect((await listUpstreams(db)).map((u) => u.slug)).toEqual(['alpha']);
  });

  it('TC-SEC-01: metadata, cluster DB, loopback names, private and odd URL forms are refused (400 ssrf_blocked)', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://postgres.platform.svc.cluster.local:5432',
      `http://localhost:${new URL(fake.url).port}/mcp`, 'http://10.0.0.5/mcp', 'http://[::1]/mcp', 'http://2130706434/mcp', 'file:///etc/passwd',
      'http://user:pw@public.example.com/mcp', 'http://nowhere.invalid/mcp']) {
      const res = await create({ slug: 'ssrf', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toMatch(/ssrf_blocked|validation_failed/);
    }
    expect((await create({ slug: 'ssrf', url: 'http://169.254.169.254/' })).json()).toMatchObject({ error: 'ssrf_blocked' });
    expect((await create({ slug: 'pub', url: 'https://public.example.com/mcp' })).statusCode).toBe(201); // public is fine
    expect((await create({ slug: 'named', url: `http://mcp.internal.test:${new URL(fake.url).port}/mcp` })).statusCode).toBe(201); // allowlisted name
  });

  it('connect-time guard: a row written around the API (localhost) is refused when the pool connects', async () => {
    const [r] = await db.insert(upstreams).values({ slug: 'sneaky', name: 'S', url: `http://localhost:${new URL(fake.url).port}/mcp` }).returning();
    const before = fake.headers.length;
    await health.checkAll();
    const h = (await req('GET', '/api/upstreams')).json().find((u: { id: string }) => u.id === r!.id);
    expect(h.status).toBe('unreachable');
    expect(h.lastError).toMatch(/ssrf_blocked/);
    // The fake behind it got no request from the sneaky row (the alpha checks are the only new ones).
    expect(fake.headers.slice(before).every((x) => x.authorization === `Bearer ${SECRET}`)).toBe(true);
    await db.delete(upstreams).where(eq(upstreams.id, r!.id));
  });

  it('members cannot create (403) — enforced on the server', async () => {
    expect((await req('POST', '/api/upstreams', { name: 'M', slug: 'mem', url: fake.url, authType: 'none' }, memberCookie)).statusCode).toBe(403);
  });

  describe('TC-UI-06-API edit (UI-06)', () => {
    it('rename keeps the credential; slug cannot change; credential replaced, never shown', async () => {
      const res = await req('PATCH', `/api/upstreams/${id}`, { name: 'Alpha 2' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Alpha 2', slug: 'alpha', hasCredential: true });
      expect(decryptCredential(key, 'alpha', (await row(id))!.credentialEnc!)).toBe(SECRET);
      expect((await req('PATCH', `/api/upstreams/${id}`, { slug: 'renamed' })).statusCode).toBe(400);
      expect((await req('PATCH', `/api/upstreams/${id}`, {})).statusCode).toBe(400);
      fake.headers.length = 0;
      const rot = await req('PATCH', `/api/upstreams/${id}`, { credential: SECRET2 });
      expect(rot.statusCode).toBe(200);
      expect(rot.body).not.toContain(SECRET2);
      expect(decryptCredential(key, 'alpha', (await row(id))!.credentialEnc!)).toBe(SECRET2);
      await health.checkAll(); // config changed → new connection with the new credential
      expect(headersSeen()).toContain(`Bearer ${SECRET2}`);
      expect(headersSeen()).not.toContain(`Bearer ${SECRET}`);
    });

    it('switch to header auth needs a name; to none clears the credential; credential null with bearer → 400', async () => {
      expect((await req('PATCH', `/api/upstreams/${id}`, { authType: 'header' })).statusCode).toBe(400);
      const h = await req('PATCH', `/api/upstreams/${id}`, { authType: 'header', authHeader: 'X-Api-Key' });
      expect(h.json()).toMatchObject({ authType: 'header', authHeader: 'X-Api-Key', hasCredential: true }); // credential kept
      expect((await req('PATCH', `/api/upstreams/${id}`, { authType: 'bearer', credential: null })).statusCode).toBe(400);
      const none = await req('PATCH', `/api/upstreams/${id}`, { authType: 'none' });
      expect(none.json()).toMatchObject({ authType: 'none', authHeader: null, hasCredential: false });
      expect((await row(id))!.credentialEnc).toBeNull();
    });

    it('URL changes pass the SSRF guard; unknown id 404', async () => {
      const bad = await req('PATCH', `/api/upstreams/${id}`, { url: 'http://169.254.169.254/' });
      expect([bad.statusCode, bad.json().error]).toEqual([400, 'ssrf_blocked']);
      expect((await row(id))!.url).toBe(fake.url);
      expect((await req('PATCH', `/api/upstreams/${randomUUID()}`, { name: 'x' })).statusCode).toBe(404);
      expect((await req('PATCH', `/api/upstreams/${id}`, { name: 'x' }, memberCookie)).statusCode).toBe(403);
    });
  });

  describe('TC-UI-07-API disable / remove (UI-07)', () => {
    it('disable → status disabled, tools 409; enable → connected again', async () => {
      const off = await req('PATCH', `/api/upstreams/${id}`, { enabled: false });
      expect(off.json()).toMatchObject({ enabled: false, status: 'disabled', toolCount: null });
      expect((await req('GET', `/api/upstreams/${id}/tools`)).statusCode).toBe(409);
      const on = await req('PATCH', `/api/upstreams/${id}`, { enabled: true });
      expect(on.json()).toMatchObject({ enabled: true, toolCount: 2 });
    });

    it('delete → 204, gone from the list, second delete 404; member 403', async () => {
      expect((await req('DELETE', `/api/upstreams/${id}`, undefined, memberCookie)).statusCode).toBe(403);
      expect((await req('DELETE', `/api/upstreams/${id}`)).statusCode).toBe(204);
      expect((await req('GET', '/api/upstreams')).json().map((u: { id: string }) => u.id)).not.toContain(id);
      expect((await req('DELETE', `/api/upstreams/${id}`)).statusCode).toBe(404);
    });
  });
});
