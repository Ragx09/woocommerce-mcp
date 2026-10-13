// AUTH-06..09 against a real Postgres and a real /mcp: generate, hashed storage, validation, revocation.
// TC-AUTH-06-1, TC-AUTH-07-1, TC-AUTH-09-1 and the key part of TC-AUTH-01 (audit rows come with AUTH-13).
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { authenticateApiKey, KEY_RE } from '../../src/auth/api-keys.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { sha256Hex } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { apiKeys, users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_keys_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'api-key-test-password';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let fake: FakeUpstream;
let mcpUrl: string;
let adminCookie: string;
let aliceCookie: string;
let aliceId: string;
let bobCookie: string;

const req = (method: string, url: string, cookie: string, payload?: object) =>
  app.inject({ method: method as 'GET', url, headers: { origin: ORIGIN, cookie }, ...(payload ? { payload } : {}) });
async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PW } });
  return String(res.headers['set-cookie']).split(';')[0]!;
}
/** tools/list on /mcp with this bearer: tool names, or the HTTP status of the refusal. */
async function mcpList(bearer: string): Promise<string[] | number> {
  const res = await fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  if (res.status !== 200) return res.status;
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  const hash = await hashPassword(PW);
  [{ id: aliceId }] = await db.insert(users).values({ email: 'alice@example.test', name: 'Alice', passwordHash: hash }).returning({ id: users.id }) as [{ id: string }];
  await db.insert(users).values({ email: 'bob@example.test', name: 'Bob', passwordHash: hash });
  fake = await startFakeUpstream({ tools: ['echo'] });
  await pool.query(`INSERT INTO upstreams (slug, name, url) VALUES ('woo', 'Woo', $1)`, [fake.url]);

  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  upstreamPool = new UpstreamPool({ key: loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') }), connectTimeoutMs: 2_000 });
  registerMcp(app, { authenticate: (t) => authenticateApiKey(db, t), loadUpstreams: () => listUpstreams(db), pool: upstreamPool,
    discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 3_000 }) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
  adminCookie = await login('admin@example.test');
  aliceCookie = await login('alice@example.test');
  bobCookie = await login('bob@example.test');
});
afterAll(async () => {
  await app?.close();
  await upstreamPool?.close();
  await fake?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('API keys (AUTH-06..09)', () => {
  it('TC-AUTH-06-1: a member generates a key (shown once) and it works on /mcp with an MCP client', async () => {
    const res = await req('POST', '/api/keys', aliceCookie, { name: 'laptop' });
    expect(res.statusCode).toBe(201);
    const k = res.json();
    expect(k).toEqual({ id: expect.any(String), name: 'laptop', prefix: k.key.slice(0, 12), createdAt: expect.any(String), key: expect.stringMatching(KEY_RE) });
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${k.key}` } } }));
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['woo__echo']);
    expect((await c.callTool({ name: 'woo__echo', arguments: { a: 1 } })).isError).toBeFalsy();
    await c.close();
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, k.id));
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
    // Listing never shows the key or its hash again.
    const list = await req('GET', '/api/keys', aliceCookie);
    expect(list.json()).toEqual([expect.objectContaining({ id: k.id, prefix: k.prefix, owner: { id: aliceId, email: 'alice@example.test', name: 'Alice' } })]);
    expect(list.body).not.toContain(k.key);
    expect(list.body).not.toContain(sha256Hex(k.key));
    expect(fake.headers.every((h) => !JSON.stringify(h).includes(k.key))).toBe(true); // never forwarded upstream
  });

  it('TC-AUTH-07-1: the database holds only SHA-256 + prefix — the plaintext key is nowhere in the table', async () => {
    const { key } = (await req('POST', '/api/keys', bobCookie, { name: 'ci' })).json();
    const dump = JSON.stringify((await pool.query('SELECT * FROM api_keys')).rows);
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(key.slice(12)); // not even the secret part
    expect(dump).toContain(sha256Hex(key));
  });

  it('admin issues a key for a user; members cannot; admin sees everyone’s keys, members only their own', async () => {
    const issued = await req('POST', `/api/users/${aliceId}/keys`, adminCookie, { name: 'issued by admin' });
    expect(issued.statusCode).toBe(201);
    expect(await mcpList(issued.json().key)).toEqual(['woo__echo']);
    expect((await req('POST', `/api/users/${aliceId}/keys`, bobCookie, { name: 'x' })).statusCode).toBe(403);
    expect((await req('POST', `/api/users/${randomUUID()}/keys`, adminCookie, { name: 'x' })).statusCode).toBe(404);
    expect((await req('POST', '/api/users/not-a-uuid/keys', adminCookie, { name: 'x' })).statusCode).toBe(400);
    const all = (await req('GET', '/api/keys?all=1', adminCookie)).json() as Array<{ owner: { email: string } }>;
    expect(new Set(all.map((k) => k.owner.email))).toEqual(new Set(['alice@example.test', 'bob@example.test']));
    expect((await req('GET', '/api/keys?all=1', bobCookie)).statusCode).toBe(403);
    expect(((await req('GET', '/api/keys', bobCookie)).json() as Array<{ owner: { email: string } }>).every((k) => k.owner.email === 'bob@example.test')).toBe(true);
  });

  it('TC-AUTH-01 (keys): no key, wrong key, malformed, wrong scheme → 401 invalid_api_key', async () => {
    const { key } = (await req('POST', '/api/keys', bobCookie, { name: 'probe' })).json();
    const forged = `mgw_${'A'.repeat(43)}`;
    for (const auth of [undefined, `Bearer ${forged}`, `Bearer ${key}x`, `Bearer ${key.slice(0, -1)}`, `Basic ${key}`, key, 'Bearer ']) {
      const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(res.status, String(auth).slice(0, 30)).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_api_key', message: 'missing or invalid API key' });
    }
    expect(await mcpList(key)).toEqual(['woo__echo']);
  });

  it('TC-AUTH-09-1: revoke → the immediately following call → 401; only owner or admin may revoke', async () => {
    const mine = (await req('POST', '/api/keys', bobCookie, { name: 'to revoke' })).json();
    expect(await mcpList(mine.key)).toEqual(['woo__echo']);
    // Alice cannot revoke Bob's key, and cannot even tell that it exists.
    const other = await req('DELETE', `/api/keys/${mine.id}`, aliceCookie);
    expect(other.statusCode).toBe(404);
    expect(await mcpList(mine.key)).toEqual(['woo__echo']);
    expect((await req('DELETE', `/api/keys/${mine.id}`, bobCookie)).statusCode).toBe(204);
    expect(await mcpList(mine.key)).toBe(401); // immediately: no cache
    expect((await req('DELETE', `/api/keys/${mine.id}`, bobCookie)).statusCode).toBe(204); // idempotent
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, mine.id));
    expect(row!.revokedAt).toBeInstanceOf(Date);
    // Admin revokes someone else's key.
    const alices = (await req('POST', '/api/keys', aliceCookie, { name: 'admin will revoke' })).json();
    expect((await req('DELETE', `/api/keys/${alices.id}`, adminCookie)).statusCode).toBe(204);
    expect(await mcpList(alices.key)).toBe(401);
    expect((await db.select().from(apiKeys).where(eq(apiKeys.id, alices.id)))[0]!.revokedBy).not.toBe(aliceId);
  });

  it('disabling a user stops all their keys at once; re-enabling restores them', async () => {
    const { key } = (await req('POST', '/api/keys', aliceCookie, { name: 'disable test' })).json();
    expect(await mcpList(key)).toEqual(['woo__echo']);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, aliceId));
    expect(await mcpList(key)).toBe(401);
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, aliceId));
    expect(await mcpList(key)).toEqual(['woo__echo']);
  });

  it('at most 20 active keys per user → 409; anonymous → 401; cross-origin → 403', async () => {
    const active = async () => ((await req('GET', '/api/keys', bobCookie)).json() as Array<{ revokedAt: string | null }>).filter((k) => !k.revokedAt).length;
    while (await active() < 20) expect((await req('POST', '/api/keys', bobCookie, { name: 'filler' })).statusCode).toBe(201);
    const over = await req('POST', '/api/keys', bobCookie, { name: 'one too many' });
    expect(over.statusCode).toBe(409);
    expect(over.json().message).toMatch(/at most 20/);
    expect((await app.inject({ method: 'POST', url: '/api/keys', headers: { origin: ORIGIN }, payload: { name: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/keys', headers: { origin: 'https://evil.example', cookie: bobCookie }, payload: { name: 'x' } })).statusCode).toBe(403);
  });
});
