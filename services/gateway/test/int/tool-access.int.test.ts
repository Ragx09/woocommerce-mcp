// BON-01 (REQ-SO-02): per-role tool permissions with real Postgres. The admin sets memberAccess per server
// through PATCH /api/upstreams/:id; members then see and can call only the allowed tools — with an API key,
// through the dashboard chat's internal token (same /mcp), and in the server list.
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createApiKey } from '../../src/auth/api-keys.js';
import { InternalTokenSigner, mcpAuthenticator } from '../../src/auth/internal-token.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { auditLog, upstreams, users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { registerUpstreamRoutes } from '../../src/upstreams/routes.js';
import { seedUpstream } from '../../src/upstreams/seed.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_tools_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'tool-access-password';
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const signer = new InternalTokenSigner();
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let health: HealthMonitor;
let woo: FakeUpstream;
let ev: FakeUpstream;
let mcpUrl: string;
let adminCookie: string;
let memberCookie: string;
let adminKey: string;
let memberKey: string;
let memberId: string;
const ids: Record<string, string> = {};
const clients: Client[] = [];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  const [m] = await db.insert(users).values({ email: 'member@example.test', name: 'M', passwordHash: await hashPassword(PW) }).returning();
  memberId = m!.id;
  const [a] = await db.select().from(users).where(eq(users.email, 'admin@example.test'));
  adminKey = (await createApiKey(db, a!.id, 'admin', a!.id)).key;
  memberKey = (await createApiKey(db, memberId, 'member', a!.id)).key;
  woo = await startFakeUpstream({ tools: ['list_orders', 'get_order', 'create_product'] });
  ev = await startFakeUpstream({ tools: ['echo'] });
  for (const [slug, url] of [['woo', woo.url], ['everything', ev.url]] as const) {
    const [r] = await db.insert(upstreams).values({ slug, name: slug, url }).returning();
    ids[slug] = r!.id;
  }
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  health = new HealthMonitor(upstreamPool, { loadUpstreams: () => listUpstreams(db), checkTimeoutMs: 1_000 });
  const discovery = new ToolDiscovery(upstreamPool, { listTimeoutMs: 1_000, health });
  registerUpstreamRoutes(app, { db, pool: upstreamPool, health, discovery, key });
  registerMcp(app, { authenticate: mcpAuthenticator(db, signer), loadUpstreams: () => listUpstreams(db),
    pool: upstreamPool, discovery, health, audit: dbAuditSink(db, app.log) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
  const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
    payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  adminCookie = await login('admin@example.test');
  memberCookie = await login('member@example.test');
});
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
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

async function client(bearer: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  clients.push(c);
  return c;
}
const names = async (bearer: string) => (await (await client(bearer)).listTools()).tools.map((t) => t.name);
const patch = (id: string, payload: unknown, cookie = adminCookie) =>
  app.inject({ method: 'PATCH', url: `/api/upstreams/${id}`, headers: { cookie, origin: ORIGIN }, payload: payload as object });

describe('TC-BON-01 per-role tool permissions (real Postgres)', () => {
  it('TC-BON-01-1: admin sets "members: woo read-only, no everything"; lists differ per role, the next request already follows', async () => {
    expect(await names(memberKey)).toEqual(['woo__list_orders', 'woo__get_order', 'woo__create_product', 'everything__echo']);
    expect((await patch(ids.woo!, { memberAccess: 'selected', memberTools: ['list_orders', 'get_order'] })).statusCode).toBe(200);
    expect((await patch(ids.everything!, { memberAccess: 'none' })).statusCode).toBe(200);

    expect(await names(memberKey)).toEqual(['woo__list_orders', 'woo__get_order']);
    expect(await names(adminKey)).toEqual(['woo__list_orders', 'woo__get_order', 'woo__create_product', 'everything__echo']);

    // Server list: members do not see the hidden server, and count only their tools; admins see the rule.
    const mine = (await app.inject({ method: 'GET', url: '/api/upstreams', headers: { cookie: memberCookie } })).json() as Record<string, unknown>[];
    expect(mine.map((u) => [u.slug, u.toolCount])).toEqual([['woo', 2]]);
    expect(mine[0]).not.toHaveProperty('memberTools');
    const theirs = (await app.inject({ method: 'GET', url: '/api/upstreams', headers: { cookie: adminCookie } })).json() as Record<string, unknown>[];
    expect(theirs.map((u) => [u.slug, u.toolCount, u.memberAccess, u.memberTools]))
      .toEqual([['woo', 3, 'selected', ['list_orders', 'get_order']], ['everything', 1, 'none', []]]);
    const tools = await app.inject({ method: 'GET', url: `/api/upstreams/${ids.woo}/tools`, headers: { cookie: memberCookie } });
    expect((tools.json() as { name: string }[]).map((t) => t.name)).toEqual(['list_orders', 'get_order']);
    expect((await app.inject({ method: 'GET', url: `/api/upstreams/${ids.everything}/tools`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
  });

  it('TC-BON-01-2: a direct call to a hidden tool is refused server-side and audited under the member', async () => {
    const before = woo.callCount() + ev.callCount();
    const member = await client(memberKey);
    for (const name of ['woo__create_product', 'everything__echo']) {
      await expect(member.callTool({ name, arguments: {} })).rejects.toThrow(/tool not allowed for your role/);
    }
    expect(woo.callCount() + ev.callCount()).toBe(before);
    expect((await member.callTool({ name: 'woo__list_orders', arguments: {} })).isError).toBeFalsy();
    const rows = await db.select().from(auditLog).where(eq(auditLog.errorCode, 'tool_forbidden'));
    expect(rows.map((r) => [r.userId, r.outcome, r.upstreamSlug]).sort())
      .toEqual([[memberId, 'rejected', 'everything'], [memberId, 'rejected', 'woo']]);
  });

  it('TC-BON-01-3: the dashboard chat (internal token, same /mcp) gets the member\'s tools, not more', async () => {
    const itk = signer.mint(memberId);
    expect(await names(itk)).toEqual(['woo__list_orders', 'woo__get_order']);
    await expect((await client(itk)).callTool({ name: 'woo__create_product', arguments: {} })).rejects.toThrow(/tool not allowed/);
    // Promoting the member takes effect on the next request (role read per request).
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, memberId));
    expect(await names(itk)).toHaveLength(4);
    await db.update(users).set({ role: 'member' }).where(eq(users.id, memberId));
  });

  it('TC-BON-01-4: only admins change rules; bad values are refused by the API and by the database', async () => {
    expect((await patch(ids.woo!, { memberAccess: 'all' }, memberCookie)).statusCode).toBe(403);
    expect((await patch(ids.woo!, { memberAccess: 'everyone' })).statusCode).toBe(400);
    expect((await patch(ids.woo!, { memberTools: ['a', 'a'] })).statusCode).toBe(400);
    expect((await patch(ids.woo!, { memberTools: ['has space'] })).statusCode).toBe(400);
    expect((await patch(ids.woo!, { memberTools: Array.from({ length: 201 }, (_, i) => `t${i}`) })).statusCode).toBe(400);
    await expect(pool.query(`UPDATE upstreams SET member_access = 'x' WHERE id = $1`, [ids.woo])).rejects.toThrow(/upstreams_member_access/);
    await expect(pool.query(`UPDATE upstreams SET member_tools = '{"a":1}' WHERE id = $1`, [ids.woo])).rejects.toThrow(/upstreams_member_tools/);
  });

  it('TC-BON-01-5: the seeder sets the chart default once; later admin edits are kept', async () => {
    const seed = { slug: 'shop', name: 'Shop', url: woo.url, authType: 'none' as const, memberTools: ['list_orders'] };
    expect(await seedUpstream(db, key, seed)).toBe('created');
    const [r] = await db.select().from(upstreams).where(eq(upstreams.slug, 'shop'));
    expect([r!.memberAccess, r!.memberTools]).toEqual(['selected', ['list_orders']]);
    expect((await patch(r!.id, { memberAccess: 'all' })).statusCode).toBe(200);
    expect(await seedUpstream(db, key, seed)).toBe('admin-edited');
    const [after] = await db.select().from(upstreams).where(eq(upstreams.slug, 'shop'));
    expect(after!.memberAccess).toBe('all');
  });
});
