// TC-BON-12-1 (API rules: caps, ownership, idempotency, slug, sharing, one-time password, delete) and
// TC-BON-14-4 (store access in /mcp and /api/upstreams: owner, shared member, other member, admin), real Postgres.
// The provisioner is played by the signed internal API (as in stores-internal.int.test.ts).
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createApiKey } from '../../src/auth/api-keys.js';
import { InternalTokenSigner, mcpAuthenticator } from '../../src/auth/internal-token.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { loadStoreAccess } from '../../src/authz/store-access.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { auditLog, stores, upstreams, users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { registerInternalStoreRoutes } from '../../src/stores/internal.js';
import { registerStoreRoutes, slugFromName } from '../../src/stores/routes.js';
import { sign, SIGNATURE_HEADER } from '../../src/stores/signing.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_storesapi_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'stores-api-password';
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const signingKey = randomBytes(32);
const signer = new InternalTokenSigner();
const WOO_TOOLS = ['list_products', 'create_product', 'list_orders', 'get_order', 'update_order_status'];
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let health: HealthMonitor;
let fake: FakeUpstream;
let mcpUrl: string;
const cookie: Record<string, string> = {};
const uid: Record<string, string> = {};
const apiKey: Record<string, string> = {};
const clients: Client[] = [];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let n = 0;
const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie: cookie[who]!, ...headers }, ...(payload ? { payload } : {}) });
const create = (who: string, body: object, idem = `idem-${++n}-${randomUUID().slice(0, 8)}`) =>
  api('POST', '/api/stores', who, body, { 'idempotency-key': idem });
const tea = (name: string) => ({ name, niche: 'tea-coffee', tagline: 'Small batches' });
const internal = (path: string, body: object) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(signingKey, 'POST', path, raw) } });
};
/** The provisioner's "ready" call for a store; the registered upstream then points at the fake MCP server. */
async function makeReady(id: string, slug: string, password = `Pw${randomBytes(12).toString('hex')}`) {
  const r = await internal(`/internal/stores/${id}/ready`, { wooMcpUrl: `http://woo-mcp.store-${slug}.svc.cluster.local/mcp`,
    wooMcpToken: 'T'.repeat(48), adminUser: 'storeadmin', adminPassword: password });
  expect(r.statusCode).toBe(200);
  await db.update(upstreams).set({ url: fake.url }).where(eq(upstreams.slug, `woo-${slug}`));
  return password;
}
async function readyStore(who: string, name: string): Promise<{ id: string; slug: string; password: string }> {
  const r = await create(who, tea(name));
  expect(r.statusCode).toBe(202);
  const { id, slug } = r.json() as Json;
  return { id, slug, password: await makeReady(id, slug) };
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'root@example.test', name: 'Root', password: PW });
  const hash = await hashPassword(PW);
  for (const nme of ['ann', 'ben', 'cat', 'dan']) await db.insert(users).values({ email: `${nme}@example.test`, name: nme, passwordHash: hash });
  for (const u of await db.select().from(users)) uid[u.email.split('@')[0]!] = u.id;
  for (const nme of ['root', 'ann', 'ben', 'cat', 'dan']) apiKey[nme] = (await createApiKey(db, uid[nme]!, nme, uid.root!)).key;
  fake = await startFakeUpstream({ tools: WOO_TOOLS });
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db), checkTimeoutMs: 1_000 });
  const discovery = new ToolDiscovery(upstreamPool, { listTimeoutMs: 1_000, health });
  const cfg = loadConfig({ LOG_LEVEL: 'silent', STORE_MAX_PER_MEMBER: '2', STORE_MAX_TOTAL: '4', STORE_HOST_SUFFIX: 'store.test', DEFAULT_STORE_URL: 'http://shop.test' });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, health, discovery, key });
  registerInternalStoreRoutes(app, { db, key, signingKey });
  registerStoreRoutes(app, { db, key, cfg: cfg.stores, enabled: true, registryChanged: async () => { await upstreamPool.sync(await listUpstreams(db)); } });
  registerMcp(app, { authenticate: mcpAuthenticator(db, signer), loadUpstreams: () => listUpstreams(db),
    storeAccess: (id) => loadStoreAccess(db, id), pool: upstreamPool, discovery, health, audit: dbAuditSink(db, app.log) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
  for (const nme of ['root', 'ann', 'ben', 'cat', 'dan']) {
    cookie[nme] = String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
      payload: { email: `${nme}@example.test`, password: PW } })).headers['set-cookie']).split(';')[0]!;
  }
});
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await app?.close();
  await health?.stop();
  await upstreamPool?.close();
  await fake?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('DELETE FROM upstreams'); await pool.query('DELETE FROM stores');
});

async function client(bearer: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  clients.push(c);
  return c;
}
const names = async (who: string) => (await (await client(apiKey[who]!)).listTools()).tools.map((t) => t.name).sort();

describe('TC-BON-12-1 /api/stores rules', () => {
  it('slug is derived from the name, previewed, and refused when too short or reserved', async () => {
    expect(slugFromName('Chai Corner!')).toBe('chai-corner');
    expect(slugFromName('  Café  Ünï — 2go ')).toBe('cafe-uni-2go');
    expect(slugFromName('9 lives')).toBe('s9-lives');
    expect(slugFromName('A very long store name indeed')).toBe('a-very-long-stor');
    const preview = async (name: string) => (await api('GET', `/api/stores/slug?name=${encodeURIComponent(name)}`, 'ann')).json() as Json;
    expect(await preview('Chai Corner')).toEqual({ slug: 'chai-corner', available: true, reason: null });
    expect((await preview('ab')).available).toBe(false);
    expect((await preview('Default')).reason).toMatch(/reserved/);
    expect((await create('ann', tea('ab'))).statusCode).toBe(400);
    expect((await create('ann', tea('Default'))).statusCode).toBe(400);
  });

  it('create: 202 provisioning with a URL; same Idempotency-Key → the same store (200); a different store under it → 409', async () => {
    const r = await create('ann', tea('Chai Corner'), 'key-chai-0001');
    expect(r.statusCode).toBe(202);
    const s = r.json() as Json;
    expect(s).toMatchObject({ slug: 'chai-corner', status: 'provisioning', url: 'http://chai-corner.store.test', role: 'owner', canManage: true, passwordAvailable: false, toolRule: null });
    expect(s).not.toHaveProperty('namespace'); // admins only
    const again = await create('ann', tea('Chai Corner'), 'key-chai-0001');
    expect([again.statusCode, (again.json() as Json).id]).toEqual([200, s.id]);
    expect((await create('ann', tea('Other Name'), 'key-chai-0001')).statusCode).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM stores')).rows[0].n).toBe(1);
    // The same name from someone else is a slug clash, and the owner of the idempotency key does not matter.
    const clash = await create('ben', tea('chai corner'));
    expect([clash.statusCode, (clash.json() as Json).error]).toEqual([409, 'slug_taken']);
  });

  it('input is validated on the server: header, niche rules, characters, unknown fields', async () => {
    const bad = (body: object, idem?: string) => create('ann', body, idem).then((r) => r.statusCode);
    expect((await api('POST', '/api/stores', 'ann', tea('No Key'))).statusCode).toBe(400); // no Idempotency-Key
    expect(await bad(tea('No Key'), 'short')).toBe(400);
    expect(await bad({ name: 'Custom Shop', niche: 'custom' })).toBe(400); // custom needs nicheText
    expect(await bad({ name: 'Tea Shop', niche: 'tea-coffee', nicheText: 'Tea' })).toBe(400); // only custom may have it
    expect(await bad({ name: 'Tea Shop', niche: 'flowers' })).toBe(400);
    expect(await bad({ name: '<script>alert(1)</script>', niche: 'bags' })).toBe(400);
    expect(await bad({ name: 'Shop"; rm -rf /', niche: 'bags' })).toBe(400);
    expect(await bad({ name: 'Tea Shop', niche: 'bags', tagline: '${HOME}' })).toBe(400);
    expect(await bad({ name: 'Tea Shop', niche: 'bags', extra: 1 })).toBe(400);
    expect(await bad({ name: 'x'.repeat(61), niche: 'bags' })).toBe(400);
    expect(await bad({ name: 'Plants & Pots', niche: 'custom', nicheText: 'Plants' })).toBe(202);
    expect((await pool.query('SELECT niche_text FROM stores')).rows[0].niche_text).toBe('Plants');
  });

  it('caps: 2 per member, 4 in total (admins count toward the total); the message says which', async () => {
    expect((await create('ann', tea('Store One'))).statusCode).toBe(202);
    expect((await create('ann', tea('Store Two'))).statusCode).toBe(202);
    const third = await create('ann', tea('Store Three'));
    expect([third.statusCode, (third.json() as Json).error, (third.json() as Json).message]).toEqual([409, 'store_limit', expect.stringMatching(/you already own 2 stores \(limit 2\)/)]);
    expect((await create('ben', tea('Store Four'))).statusCode).toBe(202);
    expect((await create('root', tea('Store Five'))).statusCode).toBe(202); // admin: no per-person cap, counts toward the total
    const full = await create('cat', tea('Store Six'));
    expect(full.statusCode).toBe(409);
    expect((full.json() as Json).message).toMatch(/limit of 4 stores/);
    expect((await create('root', tea('Store Seven'))).statusCode).toBe(409);
  });

  it('caps hold under concurrency: 8 parallel creates by one member → exactly 2 stores', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => create('dan', tea(`Parallel ${i}`))));
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(6);
    // And across members at the platform cap: 8 parallel creates from 4 people never exceed 4 stores.
    await pool.query('DELETE FROM stores');
    const mixed = await Promise.all(Array.from({ length: 12 }, (_, i) => create(['ann', 'ben', 'cat', 'dan'][i % 4]!, tea(`Mixed ${i}`))));
    expect(mixed.filter((r) => r.statusCode === 202)).toHaveLength(4);
    expect((await pool.query('SELECT count(*)::int AS n FROM stores')).rows[0].n).toBe(4);
  });

  it('ownership: others get 404 (no hint that it exists); the list holds own and shared stores only; admins see all', async () => {
    const a = (await create('ann', tea('Ann Tea'))).json() as Json;
    const b = (await create('ben', tea('Ben Tea'))).json() as Json;
    for (const [who, id] of [['ben', a.id], ['cat', a.id], ['ann', b.id]] as const) {
      expect((await api('GET', `/api/stores/${id}`, who)).statusCode).toBe(404);
      expect((await api('DELETE', `/api/stores/${id}?confirm=ann-tea`, who)).statusCode).toBe(404);
      expect((await api('POST', `/api/stores/${id}/members`, who, { email: 'dan@example.test' })).statusCode).toBe(404);
      expect((await api('POST', `/api/stores/${id}/admin-password`, who)).statusCode).toBe(404);
    }
    const list = async (who: string) => (await api('GET', '/api/stores', who)).json() as Json;
    expect((await list('ann')).stores.map((s: Json) => s.slug)).toEqual(['default', 'ann-tea']);
    expect((await list('cat')).stores.map((s: Json) => s.slug)).toEqual(['default']);
    const all = await list('root');
    expect(all.stores.map((s: Json) => s.slug)).toEqual(['default', 'ann-tea', 'ben-tea']);
    expect(all.stores[1]).toMatchObject({ namespace: 'store-ann-tea', role: 'admin', canManage: true });
    expect(all.limits).toEqual({ maxPerMember: 2, maxTotal: 4, total: 2, mine: 0 });
    expect((await api('GET', '/api/stores', 'ann')).json().stores[0]).toMatchObject({ id: 'default', isDefault: true, canManage: false, url: 'http://shop.test' });
    expect((await app.inject({ method: 'GET', url: '/api/stores' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/stores', headers: { cookie: cookie.ann!, origin: 'https://evil.example', 'idempotency-key': 'idem-evil-0001' }, payload: tea('Evil Shop') })).statusCode).toBe(403);
  });

  it('sharing: owner adds and removes people; shared members see less and cannot manage; admins and owner cannot be added', async () => {
    const s = await readyStore('ann', 'Ann Tea');
    const share = (who: string, email: string) => api('POST', `/api/stores/${s.id}/members`, who, { email });
    expect((await share('ann', 'ben@example.test')).statusCode).toBe(201);
    expect((await share('ann', 'ben@example.test')).statusCode).toBe(201); // idempotent
    expect((await share('ann', 'nobody@example.test')).statusCode).toBe(404);
    expect((await share('ann', 'ann@example.test')).statusCode).toBe(409);
    expect((await share('ann', 'root@example.test')).statusCode).toBe(409);
    expect((await share('ben', 'cat@example.test')).statusCode).toBe(403); // shared, not owner
    const seen = (await api('GET', `/api/stores/${s.id}`, 'ben')).json() as Json;
    expect(seen).toMatchObject({ slug: 'ann-tea', role: 'shared', canManage: false });
    for (const k of ['members', 'toolRule', 'passwordAvailable', 'adminUrl', 'namespace']) expect(seen).not.toHaveProperty(k);
    expect((await api('DELETE', `/api/stores/${s.id}?confirm=ann-tea`, 'ben')).statusCode).toBe(403);
    expect((await api('POST', `/api/stores/${s.id}/admin-password`, 'ben')).statusCode).toBe(403);
    expect((await api('PATCH', `/api/stores/${s.id}`, 'ben', { memberAccess: 'all' })).statusCode).toBe(403);
    const owner = (await api('GET', `/api/stores/${s.id}`, 'ann')).json() as Json;
    expect(owner.members.map((m: Json) => m.email)).toEqual(['ben@example.test']);
    expect(owner.adminUrl).toBe('http://ann-tea.store.test/wp-admin/');
    // Removing: ben may remove himself, not others; the owner may remove anyone.
    await share('ann', 'cat@example.test');
    expect((await api('DELETE', `/api/stores/${s.id}/members/${uid.cat}`, 'ben')).statusCode).toBe(403);
    expect((await api('DELETE', `/api/stores/${s.id}/members/${uid.ben}`, 'ben')).statusCode).toBe(204);
    expect((await api('GET', `/api/stores/${s.id}`, 'ben')).statusCode).toBe(404);
    expect((await api('DELETE', `/api/stores/${s.id}/members/${uid.cat}`, 'ann')).statusCode).toBe(204);
    expect((await pool.query('SELECT count(*)::int AS n FROM store_members')).rows[0].n).toBe(0);
  });

  it('wp-admin password: shown exactly once (also under concurrency), only to owner or admin, then gone from the database', async () => {
    const s = await readyStore('ann', 'Ann Tea');
    expect(((await api('GET', `/api/stores/${s.id}`, 'ann')).json() as Json).passwordAvailable).toBe(true);
    const shots = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', `/api/stores/${s.id}/admin-password`, 'ann')));
    const ok = shots.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.json()).toEqual({ username: 'storeadmin', password: s.password });
    expect(ok[0]!.headers['cache-control']).toBe('no-store');
    expect(shots.filter((r) => r.statusCode === 410)).toHaveLength(4);
    const [row] = await db.select().from(stores).where(eq(stores.id, s.id));
    expect([row!.adminPasswordEnc, row!.adminPasswordViewedAt === null]).toEqual([null, false]);
    expect(((await api('GET', `/api/stores/${s.id}`, 'ann')).json() as Json).passwordAvailable).toBe(false);
    // An admin sees a different store's password once as well; the plaintext is in no other column.
    const t = await readyStore('ben', 'Ben Tea');
    expect(((await api('POST', `/api/stores/${t.id}/admin-password`, 'root')).json() as Json).password).toBe(t.password);
    expect(JSON.stringify((await pool.query('SELECT * FROM stores')).rows)).not.toContain(s.password);
    expect(JSON.stringify((await pool.query('SELECT * FROM upstreams')).rows)).not.toContain('T'.repeat(48));
  });

  it('tool rule for shared members: default read-only, widened or narrowed by the owner, validated', async () => {
    const s = await readyStore('ann', 'Ann Tea');
    await api('POST', `/api/stores/${s.id}/members`, 'ann', { email: 'cat@example.test' });
    const owner = (await api('GET', `/api/stores/${s.id}`, 'ann')).json() as Json;
    expect(owner.toolRule).toEqual({ memberAccess: 'selected', memberTools: ['list_products', 'list_orders', 'get_order'] });
    const patch = (who: string, body: object) => api('PATCH', `/api/stores/${s.id}`, who, body);
    expect((await patch('ann', { memberAccess: 'selected', memberTools: ['drop_database'] })).statusCode).toBe(400);
    expect((await patch('ann', { memberAccess: 'selected', memberTools: [] })).statusCode).toBe(400);
    expect((await patch('ann', { memberAccess: 'sometimes' })).statusCode).toBe(400);
    expect(((await patch('ann', { memberAccess: 'all' })).json() as Json).toolRule).toEqual({ memberAccess: 'all', memberTools: [] });
    expect(((await patch('root', { memberAccess: 'none' })).json() as Json).toolRule).toEqual({ memberAccess: 'none', memberTools: [] });
    const p = await create('ben', tea('Pending Shop'));
    expect((await api('PATCH', `/api/stores/${(p.json() as Json).id}`, 'ben', { memberAccess: 'all' })).statusCode).toBe(409); // not registered yet
  });

  it('delete: owner or admin with the name typed back; tools vanish at once; teardown completes through the provisioner; the name is free again', async () => {
    const s = await readyStore('ann', 'Ann Tea');
    expect((await api('DELETE', `/api/stores/${s.id}`, 'ann')).statusCode).toBe(400);
    expect((await api('DELETE', `/api/stores/${s.id}?confirm=wrong`, 'ann')).statusCode).toBe(400);
    expect((await names('ann')).length).toBe(WOO_TOOLS.length);
    const del = await api('DELETE', `/api/stores/${s.id}?confirm=ann-tea`, 'ann');
    expect(del.statusCode).toBe(202);
    expect(del.json()).toMatchObject({ status: 'deleting' });
    const [row] = await db.select().from(stores).where(eq(stores.id, s.id));
    expect([row!.desired, row!.status, row!.adminPasswordEnc]).toEqual(['absent', 'deleting', null]);
    expect((await pool.query('SELECT count(*)::int AS n FROM upstreams')).rows[0].n).toBe(0);
    expect(await names('ann')).toEqual([]); // the very next request
    expect((await api('DELETE', `/api/stores/${s.id}?confirm=ann-tea`, 'ann')).statusCode).toBe(202); // retry is harmless
    expect((await internal(`/internal/stores/${s.id}/deleted`, {})).statusCode).toBe(200);
    expect((await api('GET', `/api/stores/${s.id}`, 'ann')).statusCode).toBe(404);
    expect(((await api('GET', '/api/stores', 'ann')).json() as Json).stores.map((x: Json) => x.slug)).toEqual(['default']);
    // Deleted stores no longer count against the caps, and the name can be used again.
    const again = await create('ann', tea('Ann Tea'));
    expect([again.statusCode, (again.json() as Json).slug]).toEqual([202, 'ann-tea']);
    // An admin can delete someone else's store.
    const t = await readyStore('ben', 'Ben Tea');
    expect((await api('DELETE', `/api/stores/${t.id}?confirm=ben-tea`, 'root')).statusCode).toBe(202);
  });

  it('a store\'s server cannot be edited or deleted through /api/upstreams, except enabled and the member rule', async () => {
    const s = await readyStore('ann', 'Ann Tea');
    const [u] = await db.select().from(upstreams).where(eq(upstreams.storeId, s.id));
    const patch = (body: object) => api('PATCH', `/api/upstreams/${u!.id}`, 'root', body);
    expect((await patch({ url: 'http://evil.example/mcp' })).statusCode).toBe(409);
    expect((await patch({ credential: 'x' })).statusCode).toBe(409);
    expect((await patch({ name: 'renamed' })).statusCode).toBe(409);
    expect((await patch({ memberAccess: 'none' })).statusCode).toBe(200);
    expect((await api('DELETE', `/api/upstreams/${u!.id}`, 'root')).statusCode).toBe(409);
  });
});

describe('TC-BON-14-4 store access in /mcp and /api/upstreams', () => {
  it('owner all tools · shared member the store rule · other member nothing · admin everything', async () => {
    const a = await readyStore('ann', 'Ann Tea');
    const b = await readyStore('ben', 'Ben Tea');
    await api('POST', `/api/stores/${a.id}/members`, 'ann', { email: 'cat@example.test' });
    const all = (slug: string) => WOO_TOOLS.map((t) => `woo-${slug}__${t}`).sort();
    const readOnly = (slug: string) => ['list_products', 'list_orders', 'get_order'].map((t) => `woo-${slug}__${t}`).sort();

    expect(await names('ann')).toEqual(all('ann-tea'));
    expect(await names('ben')).toEqual(all('ben-tea'));
    expect(await names('cat')).toEqual(readOnly('ann-tea'));
    expect(await names('dan')).toEqual([]);
    expect(await names('root')).toEqual([...all('ann-tea'), ...all('ben-tea')].sort());

    // The dashboard chat uses the same /mcp with an internal token: same answers.
    const itk = (await (await client(signer.mint(uid.cat!))).listTools()).tools.map((t) => t.name).sort();
    expect(itk).toEqual(readOnly('ann-tea'));

    // Server list: each person sees their stores' servers only; the owner's view carries no admin fields.
    const servers = async (who: string) => ((await api('GET', '/api/upstreams', who)).json() as Json[]);
    expect((await servers('ann')).map((s) => [s.slug, s.toolCount])).toEqual([['woo-ann-tea', 5]]);
    expect((await servers('ann'))[0]).not.toHaveProperty('url');
    expect((await servers('cat')).map((s) => [s.slug, s.toolCount])).toEqual([['woo-ann-tea', 3]]);
    expect(await servers('dan')).toEqual([]);
    expect((await servers('root')).map((s) => s.slug)).toEqual(['woo-ann-tea', 'woo-ben-tea']);
    const [ua] = await db.select().from(upstreams).where(eq(upstreams.storeId, a.id));
    const toolsOf = async (who: string, id: string) => api('GET', `/api/upstreams/${id}/tools`, who);
    expect((await toolsOf('dan', ua!.id)).statusCode).toBe(404);
    expect((await toolsOf('ben', ua!.id)).statusCode).toBe(404);
    expect(((await toolsOf('cat', ua!.id)).json() as Json[]).map((t) => t.name).sort()).toEqual(['get_order', 'list_orders', 'list_products']);
    void b;
  });

  it('calls: shared members are limited to the rule, strangers are refused, every refusal is audited and reaches no upstream', async () => {
    const a = await readyStore('ann', 'Ann Tea');
    await readyStore('ben', 'Ben Tea');
    await api('POST', `/api/stores/${a.id}/members`, 'ann', { email: 'cat@example.test' });
    const before = fake.callCount();
    const refused = async (who: string, name: string) => expect((await client(apiKey[who]!)).callTool({ name, arguments: {} })).rejects.toThrow(/tool not allowed for your role/);
    await refused('cat', 'woo-ann-tea__create_product'); // beyond the read-only rule
    await refused('cat', 'woo-ben-tea__list_orders'); // someone else's store
    await refused('dan', 'woo-ann-tea__list_orders'); // no access at all
    await refused('ann', 'woo-ben-tea__list_orders'); // owner of another store
    expect(fake.callCount()).toBe(before);
    expect((await (await client(apiKey.cat!)).callTool({ name: 'woo-ann-tea__list_orders', arguments: {} })).isError).toBeFalsy();
    expect((await (await client(apiKey.ann!)).callTool({ name: 'woo-ann-tea__create_product', arguments: {} })).isError).toBeFalsy();
    expect((await (await client(apiKey.root!)).callTool({ name: 'woo-ben-tea__update_order_status', arguments: {} })).isError).toBeFalsy();
    const rows = await db.select().from(auditLog).where(eq(auditLog.errorCode, 'tool_forbidden'));
    expect(rows.map((r) => [r.userId, r.outcome, r.upstreamSlug]).sort())
      .toEqual([[uid.ann, 'rejected', 'woo-ben-tea'], [uid.cat, 'rejected', 'woo-ann-tea'], [uid.cat, 'rejected', 'woo-ben-tea'], [uid.dan, 'rejected', 'woo-ann-tea']].sort());
  });

  it('changes apply on the very next request: widen the rule, remove the person, delete the store', async () => {
    const a = await readyStore('ann', 'Ann Tea');
    await api('POST', `/api/stores/${a.id}/members`, 'ann', { email: 'cat@example.test' });
    expect((await names('cat')).length).toBe(3);
    await api('PATCH', `/api/stores/${a.id}`, 'ann', { memberAccess: 'all' });
    expect((await names('cat')).length).toBe(5);
    await api('PATCH', `/api/stores/${a.id}`, 'ann', { memberAccess: 'selected', memberTools: ['get_order'] });
    expect(await names('cat')).toEqual(['woo-ann-tea__get_order']);
    await api('DELETE', `/api/stores/${a.id}/members/${uid.cat}`, 'ann');
    expect(await names('cat')).toEqual([]);
    // Transfer of power is not possible by editing the database role either: a disabled owner loses the key itself.
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid.ann!));
    await expect(client(apiKey.ann!)).rejects.toThrow();
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, uid.ann!));
    await api('DELETE', `/api/stores/${a.id}?confirm=ann-tea`, 'ann');
    expect(await names('ann')).toEqual([]);
  });

  it('a store row that is gone or deleted grants nothing; without a store-access source a non-admin sees no store', async () => {
    const a = await readyStore('ann', 'Ann Tea');
    await db.update(stores).set({ status: 'deleted' }).where(eq(stores.id, a.id));
    expect(await names('ann')).toEqual([]);
    expect(await names('root')).toHaveLength(5); // the upstream row still exists in this contrived state; admins see servers
    expect((await loadStoreAccess(db, uid.ann!)).size).toBe(0);
  });
});
