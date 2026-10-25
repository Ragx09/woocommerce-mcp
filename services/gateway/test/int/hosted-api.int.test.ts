// TC-BON-10-2 (int, real Postgres): hosting MCP servers by image — admin only, registry allowlist, image/env/slug
// validation, caps under concurrency, write-only encrypted secrets, signed registration, delete + name reuse.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { decryptCredential, loadCredentialKey, type CredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { hostedServers, upstreams, users } from '../../src/db/schema.js';
import { registerHostedRoutes } from '../../src/hosted/routes.js';
import { registerInternalHostedRoutes } from '../../src/hosted/internal.js';
import { hostedEnvKey, sign, SIGNATURE_HEADER } from '../../src/stores/signing.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_hosted_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'hosted-api-password';
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const signingKey = randomBytes(32);
const REG = ['ghcr.io/acme', 'registry.k8s.io'];
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let health: HealthMonitor;
const cookie: Record<string, string> = {};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who: string, payload?: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: cookie[who]! }, ...(payload ? { payload } : {}) });
const good = (slug: string, extra: object = {}) => ({ name: `Server ${slug}`, slug, image: 'ghcr.io/acme/echo-mcp:1.2.3', port: 3000, ...extra });
const internal = (path: string, body: object, tamper = false) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, payload: tamper ? raw.replace('hosted', 'hostex') : raw,
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(signingKey, 'POST', path, raw) } });
};
const readyUrl = (slug: string, path = '/mcp') => `http://server.hosted-${slug}.svc.cluster.local${path}`;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'root@example.test', name: 'Root', password: PW });
  await db.insert(users).values({ email: 'mia@example.test', name: 'mia', passwordHash: await hashPassword(PW) });
  await db.insert(upstreams).values({ slug: 'woo', name: 'woo', url: 'http://woo.test/mcp' });
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db), checkTimeoutMs: 1_000 });
  const discovery = new ToolDiscovery(upstreamPool, { listTimeoutMs: 1_000, health });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, health, discovery, key });
  registerHostedRoutes(app, { db, signingKey, registries: REG, max: 3, registryChanged: async () => { await upstreamPool.sync(await listUpstreams(db)); } });
  registerInternalHostedRoutes(app, { db, signingKey });
  await app.ready();
  for (const [who, email] of [['root', 'root@example.test'], ['mia', 'mia@example.test']] as const) {
    cookie[who] = String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  }
});
afterAll(async () => {
  await app?.close();
  await health?.stop();
  await upstreamPool?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query(`DELETE FROM upstreams WHERE slug <> 'woo'`); await pool.query('DELETE FROM hosted_servers');
});

describe('TC-BON-10-2 hosted servers API', () => {
  it('admin only: anonymous 401, member 403, on every route', async () => {
    const h = (await api('POST', '/api/hosted', 'root', good('echo'))).json() as Json;
    const calls: [string, string, object?][] = [['GET', '/api/hosted'], ['POST', '/api/hosted', good('other')], ['GET', `/api/hosted/${h.id}`], ['DELETE', `/api/hosted/${h.id}?confirm=echo`]];
    for (const [m, u, b] of calls) {
      expect((await api(m as 'GET', u, 'mia', b)).statusCode, `${m} ${u} as member`).toBe(403);
      expect((await app.inject({ method: m as 'GET', url: u, ...(b ? { payload: b } : {}) })).statusCode, `${m} ${u} anonymous`).toBe(401);
    }
    expect((await pool.query('SELECT status FROM hosted_servers')).rows).toEqual([{ status: 'provisioning' }]); // the refused calls changed nothing
  });

  it('registry allowlist: only listed registries, a fixed tag or digest, fully qualified, no tricks', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const ok = ['ghcr.io/acme/echo-mcp:1.2.3', `registry.k8s.io/x/y@${digest}`, 'ghcr.io/acme/deep/path/tool:v2'];
    for (const [i, image] of ok.entries()) { expect((await api('POST', '/api/hosted', 'root', good(`ok${i}x`, { image }))).statusCode, image).toBe(202); await pool.query('DELETE FROM hosted_servers'); }
    const bad: [string, string][] = [
      ['docker.io/library/nginx:1.27', 'registry_not_allowed'], ['evil.example/acme/x:1', 'registry_not_allowed'],
      ['ghcr.io/acmeevil/tool:1', 'registry_not_allowed'], // prefix trick: ghcr.io/acme is not ghcr.io/acmeevil
      ['ghcr.io/acme/../evil/x:1', 'validation_failed'], ['ghcr.io/acme//x:1', 'validation_failed'],
      ['ghcr.io/acme/tool:latest', 'validation_failed'], ['ghcr.io/acme/tool', 'validation_failed'],
      ['nginx:1.27', 'validation_failed'], ['GHCR.io/acme/tool:1', 'validation_failed'], ['ghcr.io/acme/tool:1 --privileged', 'validation_failed'],
      ['ghcr.io/acme/tool@sha256:abc', 'validation_failed'], ['http://ghcr.io/acme/tool:1', 'validation_failed'],
    ];
    for (const [image, code] of bad) {
      const r = await api('POST', '/api/hosted', 'root', good('badone', { image }));
      expect([image, r.statusCode, (r.json() as Json).error]).toEqual([image, 400, code]);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM hosted_servers')).rows[0].n).toBe(0);
    // The database refuses a bad image even when the API is bypassed.
    await expect(pool.query(`INSERT INTO hosted_servers (slug,name,image,port) VALUES ('rawx','x','nginx; rm -rf /',80)`)).rejects.toThrow(/hosted_image_format/);
  });

  it('validation: slug, port, path, env names, reserved names, plain vs secret, unknown fields', async () => {
    const code = async (body: object) => (await api('POST', '/api/hosted', 'root', body)).statusCode;
    expect(await code(good('Echo'))).toBe(400);
    expect(await code(good('a--b'))).toBe(400);
    expect(await code(good('ab'))).toBe(400);
    expect(await code(good('default'))).toBe(400);
    expect(await code(good('echo', { port: 0 }))).toBe(400);
    expect(await code(good('echo', { port: 70000 }))).toBe(400);
    expect(await code(good('echo', { path: 'mcp' }))).toBe(400);
    expect(await code(good('echo', { path: '/a b' }))).toBe(400);
    expect(await code(good('echo', { env: { lower: 'x' } }))).toBe(400);
    expect(await code(good('echo', { env: { LD_PRELOAD: '/x.so' } }))).toBe(400);
    expect(await code(good('echo', { env: { KUBERNETES_SERVICE_HOST: 'x' } }))).toBe(400);
    expect(await code(good('echo', { env: { A: 'x' }, secretEnv: { A: 'y' } }))).toBe(400);
    expect(await code(good('echo', { env: { A: 'multi\nline' } }))).toBe(400);
    expect(await code(good('echo', { privileged: true }))).toBe(400);
    expect(await code(good('woo'))).toBe(409); // an upstream already has this slug
    expect(await code(good('echo', { env: { MODE: 'demo' }, allowEgress: true }))).toBe(202);
    expect((await api('POST', '/api/hosted', 'root', good('echo'))).statusCode).toBe(409); // hosted slug taken
  });

  it('secret environment is write-only: encrypted at rest with the derived key, never returned, names only', async () => {
    const r = await api('POST', '/api/hosted', 'root', good('vault', { env: { MODE: 'demo' }, secretEnv: { API_TOKEN: 'tok-SECRET-value-123', DB_PASS: 'p@ss-SECRET-456' } }));
    expect(r.statusCode).toBe(202);
    const created = r.json() as Json;
    expect(created).toMatchObject({ slug: 'vault', status: 'provisioning', namespace: 'hosted-vault', env: { MODE: 'demo' }, secretEnvNames: ['API_TOKEN', 'DB_PASS'], allowEgress: false });
    for (const res of [r, await api('GET', '/api/hosted', 'root'), await api('GET', `/api/hosted/${created.id}`, 'root')]) {
      expect(res.body).not.toContain('SECRET');
      expect(res.body).not.toContain('secretEnvEnc');
    }
    const [row] = await db.select().from(hostedServers).where(eq(hostedServers.slug, 'vault'));
    expect(JSON.stringify(row)).not.toContain('SECRET');
    const plain = JSON.parse(decryptCredential(hostedEnvKey(signingKey) as CredentialKey, 'hosted:vault', row!.secretEnvEnc!));
    expect(plain).toEqual({ API_TOKEN: 'tok-SECRET-value-123', DB_PASS: 'p@ss-SECRET-456' });
    // Bound to its server and to the signing key: copied to another slug or opened with another key, it does not decrypt.
    expect(() => decryptCredential(hostedEnvKey(signingKey) as CredentialKey, 'hosted:other', row!.secretEnvEnc!)).toThrow();
    expect(() => decryptCredential(hostedEnvKey(randomBytes(32)) as CredentialKey, 'hosted:vault', row!.secretEnvEnc!)).toThrow();
    expect(() => decryptCredential(key, 'hosted:vault', row!.secretEnvEnc!)).toThrow(); // the gateway's own credentials key cannot open it either
  });

  it('cap of 3 holds under concurrency (6 parallel creates → exactly 3)', async () => {
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => api('POST', '/api/hosted', 'root', good(`par${i}x`))));
    expect(res.filter((r) => r.statusCode === 202)).toHaveLength(3);
    expect(res.filter((r) => r.statusCode === 409).map((r) => (r.json() as Json).error)).toEqual(['hosted_limit', 'hosted_limit', 'hosted_limit']);
  });

  it('signed registration: ready creates the upstream (members: none), wrong URLs and unsigned calls are refused, calls are idempotent', async () => {
    const h = (await api('POST', '/api/hosted', 'root', good('echo', { path: '/api/mcp' }))).json() as Json;
    const path = `/internal/hosted/${h.id}/ready`;
    expect((await app.inject({ method: 'POST', url: path, payload: { url: readyUrl('echo', '/api/mcp') }, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect((await internal(path, { url: readyUrl('echo', '/api/mcp') }, true)).statusCode).toBe(401); // body changed after signing
    for (const url of [readyUrl('other', '/api/mcp'), readyUrl('echo', '/mcp'), 'http://evil.example/api/mcp', `http://server.hosted-echo.svc.cluster.local:8080/api/mcp`,
      'https://server.hosted-echo.svc.cluster.local/api/mcp', 'http://woo-mcp.store-echo.svc.cluster.local/api/mcp', 'http://user:pw@server.hosted-echo.svc.cluster.local/api/mcp']) {
      expect([url, (await internal(path, { url })).statusCode]).toEqual([url, 400]);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM upstreams WHERE hosted_id IS NOT NULL')).rows[0].n).toBe(0);
    expect((await internal(path, { url: readyUrl('echo', '/api/mcp') })).statusCode).toBe(200);
    expect((await internal(path, { url: readyUrl('echo', '/api/mcp') })).statusCode).toBe(200); // retried call
    const [u] = await db.select().from(upstreams).where(eq(upstreams.slug, 'echo'));
    expect(u).toMatchObject({ authType: 'none', credentialEnc: null, memberAccess: 'none', hostedId: h.id, url: readyUrl('echo', '/api/mcp') });
    expect(((await api('GET', `/api/hosted/${h.id}`, 'root')).json() as Json)).toMatchObject({ status: 'ready', upstreamId: u!.id });
    // Servers page: admins see it with kind=hosted; members do not until an admin allows them.
    const list = async (who: string) => (await api('GET', '/api/upstreams', who)).json() as Json[];
    expect((await list('root')).find((s) => s.slug === 'echo')).toMatchObject({ kind: 'hosted' });
    expect((await list('mia')).map((s) => s.slug)).not.toContain('echo');
    expect((await api('PATCH', `/api/upstreams/${u!.id}`, 'root', { memberAccess: 'selected', memberTools: ['echo'] })).statusCode).toBe(200);
    expect((await list('mia')).map((s) => s.slug)).toContain('echo');
    // Owned by the platform: address, credential and name cannot be edited, and it cannot be deleted from the servers page.
    for (const body of [{ url: 'http://evil.example/mcp' }, { credential: 'x', authType: 'bearer' }, { name: 'renamed' }]) {
      expect((await api('PATCH', `/api/upstreams/${u!.id}`, 'root', body)).statusCode).toBe(409);
    }
    expect((await api('DELETE', `/api/upstreams/${u!.id}`, 'root')).statusCode).toBe(409);
  });

  it('failed: a clear reason is kept; a later ready call cannot resurrect it', async () => {
    const h = (await api('POST', '/api/hosted', 'root', good('broke'))).json() as Json;
    expect((await internal(`/internal/hosted/${h.id}/failed`, { reason: 'image pull failed: not found' })).statusCode).toBe(200);
    expect(((await api('GET', `/api/hosted/${h.id}`, 'root')).json() as Json)).toMatchObject({ status: 'failed', statusReason: 'image pull failed: not found' });
    expect((await internal(`/internal/hosted/${h.id}/ready`, { url: readyUrl('broke') })).statusCode).toBe(409);
    expect((await internal(`/internal/hosted/${h.id}/failed`, { reason: '' })).statusCode).toBe(400);
  });

  it('delete: slug typed back; unregistered at once; secret wiped; provisioner confirms; the name is free again', async () => {
    const h = (await api('POST', '/api/hosted', 'root', good('echo', { secretEnv: { API_TOKEN: 'secret-value-1234' } }))).json() as Json;
    await internal(`/internal/hosted/${h.id}/ready`, { url: readyUrl('echo') });
    expect((await api('DELETE', `/api/hosted/${h.id}`, 'root')).statusCode).toBe(400);
    expect((await api('DELETE', `/api/hosted/${h.id}?confirm=nope`, 'root')).statusCode).toBe(400);
    const del = await api('DELETE', `/api/hosted/${h.id}?confirm=echo`, 'root');
    expect([del.statusCode, (del.json() as Json).status]).toEqual([202, 'deleting']);
    const [row] = await db.select().from(hostedServers).where(eq(hostedServers.id, h.id));
    expect([row!.desired, row!.secretEnvEnc]).toEqual(['absent', null]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM upstreams WHERE slug = 'echo'`)).rows[0].n).toBe(0);
    expect((await internal(`/internal/hosted/${h.id}/ready`, { url: readyUrl('echo') })).statusCode).toBe(409);
    expect((await api('DELETE', `/api/hosted/${h.id}?confirm=echo`, 'root')).statusCode).toBe(202); // retry
    expect((await internal(`/internal/hosted/${h.id}/deleted`, {})).statusCode).toBe(200);
    expect((await api('GET', `/api/hosted/${h.id}`, 'root')).statusCode).toBe(404);
    expect((await api('POST', '/api/hosted', 'root', good('echo'))).statusCode).toBe(202);
  });

  it('hosting is off without allowed registries or a provisioner key', async () => {
    const off = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
    await registerAuth(off, { db, cookieSecure: false, publicOrigin: ORIGIN });
    registerHostedRoutes(off, { db, signingKey: null, registries: REG, max: 3 });
    await off.ready();
    const c = String((await off.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'root@example.test', password: PW } })).headers['set-cookie']).split(';')[0]!;
    const r = await off.inject({ method: 'POST', url: '/api/hosted', headers: { origin: ORIGIN, cookie: c }, payload: good('echo') });
    expect([r.statusCode, (r.json() as Json).error]).toEqual([503, 'hosting_unavailable']);
    expect(((await off.inject({ method: 'GET', url: '/api/hosted', headers: { cookie: c } })).json() as Json).enabled).toBe(false);
    await off.close();
  });
});

describe('BON-12/14 hosted runtime and recovery', () => {
  it('runtime numbers are shown to admins; a vanished namespace makes a ready server Failed and unregisters it', async () => {
    const h = (await api('POST', '/api/hosted', 'root', good('echo'))).json() as Json;
    await internal(`/internal/hosted/${h.id}/ready`, { url: readyUrl('echo') });
    expect((await internal(`/internal/hosted/${h.id}/runtime`, { pods: { ready: 1, total: 1 }, quota: { cpuLimits: { used: 0.5, hard: 1 }, memoryLimitsMiB: { used: 256, hard: 512 } } })).statusCode).toBe(200);
    expect((await internal(`/internal/hosted/${h.id}/runtime`, { pods: { ready: 3, total: 1 } })).statusCode).toBe(400);
    expect(((await api('GET', `/api/hosted/${h.id}`, 'root')).json() as Json).runtime).toMatchObject({ pods: { ready: 1, total: 1 }, quota: { memoryLimitsMiB: { hard: 512 } } });
    const miss = `/internal/hosted/${h.id}/missing`;
    expect((await app.inject({ method: 'POST', url: miss, payload: {}, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect(((await internal(miss, {})).json() as Json).status).toBe('failed');
    expect(((await internal(miss, {})).json() as Json).status).toBe('failed');
    const after = (await api('GET', `/api/hosted/${h.id}`, 'root')).json() as Json;
    expect(after).toMatchObject({ status: 'failed', statusReason: expect.stringMatching(/removed outside the platform/), runtime: null, upstreamId: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM upstreams WHERE slug = 'echo'`)).rows[0].n).toBe(0);
    expect((await api('DELETE', `/api/hosted/${h.id}?confirm=echo`, 'root')).statusCode).toBe(202);
    expect((await internal(`/internal/hosted/${h.id}/deleted`, {})).statusCode).toBe(200);
  });
});
