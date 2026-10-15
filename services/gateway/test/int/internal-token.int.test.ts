// TC-UI-15-1 / TC-UI-15-2 (UI-15): the chat agent's internal token on the real /mcp with real Postgres.
// 1: a token for a user → tools/list + tools/call work; audit rows carry that user, no key, source=chat.
// 2: expired, forged, other-process and non-loopback tokens → 401 (audited as denied); a disabled user's
//    still-valid token → 401 at the next request; API keys keep working from any address.
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { createApiKey } from '../../src/auth/api-keys.js';
import { INTERNAL_TOKEN_TTL_MS, InternalTokenSigner, mcpAuthenticator } from '../../src/auth/internal-token.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_itk_${randomUUID().slice(0, 8)}`;
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let woo: FakeUpstream;
let mcpUrl: string;
const signer = new InternalTokenSigner();
const who: Record<'alice' | 'bob', { userId: string; key: string }> = {} as never;

async function client(bearer: string): Promise<Client> {
  const c = new Client({ name: 'chat-agent', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  return c;
}
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
/** One raw /mcp request through inject, from a chosen TCP peer address. */
const inject = (bearer: string, remoteAddress = '127.0.0.1', extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/mcp', remoteAddress, headers: { ...MCP_HEADERS, authorization: `Bearer ${bearer}`, ...extra }, payload: LIST });
const rows = async () => (await pool.query('SELECT user_id, api_key_id, source, method, tool, outcome, error_code FROM audit_log ORDER BY id')).rows;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const hash = await hashPassword('itk-test-password');
  for (const name of ['alice', 'bob'] as const) {
    const [u] = await db.insert(users).values({ email: `${name}@example.test`, name, passwordHash: hash }).returning({ id: users.id });
    who[name] = { userId: u!.id, key: (await createApiKey(db, u!.id, `${name} key`, u!.id)).key };
  }
  woo = await startFakeUpstream({ tools: ['echo'] });
  await pool.query(`INSERT INTO upstreams (slug, name, url) VALUES ('woo', 'Woo', $1)`, [woo.url]);

  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  upstreamPool = new UpstreamPool({ key: loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') }), connectTimeoutMs: 1_000 });
  registerMcp(app, { authenticate: mcpAuthenticator(db, signer), loadUpstreams: () => listUpstreams(db), pool: upstreamPool,
    discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 2_000 }), audit: dbAuditSink(db, app.log) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
});
afterAll(async () => {
  await app?.close();
  await upstreamPool?.close();
  await woo?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE audit_log');
  await pool.query('UPDATE users SET disabled_at = NULL');
});

describe('TC-UI-15-1 chat token → /mcp as the user, audited with source=chat', () => {
  it('alice and bob each get their own rows; no API key is recorded', async () => {
    for (const name of ['alice', 'bob'] as const) {
      const c = await client(signer.mint(who[name].userId));
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['woo__echo']);
      expect((await c.callTool({ name: 'woo__echo', arguments: { text: 'hi' } })).isError).toBeFalsy();
      await c.close();
    }
    const calls = (await rows()).filter((r) => r.method !== 'initialize');
    expect(calls).toEqual([
      { user_id: who.alice.userId, api_key_id: null, source: 'chat', method: 'tools/list', tool: null, outcome: 'ok', error_code: null },
      { user_id: who.alice.userId, api_key_id: null, source: 'chat', method: 'tools/call', tool: 'echo', outcome: 'ok', error_code: null },
      { user_id: who.bob.userId, api_key_id: null, source: 'chat', method: 'tools/list', tool: null, outcome: 'ok', error_code: null },
      { user_id: who.bob.userId, api_key_id: null, source: 'chat', method: 'tools/call', tool: 'echo', outcome: 'ok', error_code: null },
    ]);
  });

  it('the same user through an API key is recorded as source=mcp (unchanged)', async () => {
    expect((await inject(who.alice.key, '10.42.0.9')).statusCode).toBe(200);
    expect((await rows()).at(-1)).toMatchObject({ user_id: who.alice.userId, source: 'mcp', outcome: 'ok' });
  });
});

describe('TC-UI-15-2 refused chat tokens', () => {
  it('expired, forged, other-process and garbage tokens → 401, audited as denied without a user', async () => {
    const expired = signer.mint(who.alice.userId, Date.now() - INTERNAL_TOKEN_TTL_MS - 1);
    const otherProcess = new InternalTokenSigner().mint(who.alice.userId);
    const [, sig] = signer.mint(who.alice.userId).split('.');
    const forged = `itk_${Buffer.from(JSON.stringify({ sub: who.bob.userId, src: 'chat', exp: Date.now() + 60_000 })).toString('base64url')}.${sig}`;
    for (const t of [expired, otherProcess, forged, 'itk_garbage']) {
      const res = await inject(t);
      expect(res.statusCode, t.slice(0, 12)).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_api_key', message: 'missing or invalid API key' });
    }
    expect(await rows()).toEqual(Array(4).fill({ user_id: null, api_key_id: null, source: 'mcp', method: 'tools/list', tool: null, outcome: 'denied', error_code: 'invalid_api_key' }));
  });

  it('a valid token from a non-loopback peer (via the Ingress) → 401, even with X-Forwarded-For: 127.0.0.1', async () => {
    const t = signer.mint(who.alice.userId);
    expect((await inject(t, '127.0.0.1')).statusCode).toBe(200);
    for (const peer of ['10.42.0.9', '::ffff:10.42.0.9']) {
      expect((await inject(t, peer, { 'x-forwarded-for': '127.0.0.1' })).statusCode).toBe(401);
    }
  });

  it('disabling the user stops a still-valid token at the next request', async () => {
    const t = signer.mint(who.bob.userId);
    expect((await inject(t)).statusCode).toBe(200);
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [who.bob.userId]);
    expect((await inject(t)).statusCode).toBe(401);
  });
});
