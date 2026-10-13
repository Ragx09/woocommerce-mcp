// TC-AUTH-05 (AUTH-13): audit row fields complete for every outcome; TC-AUTH-11-1 (AUTH-11): each row is
// attributed to the user and key that made the call; TC-AUTH-01: refused requests audited as denied
// without a user. Real Postgres, real /mcp, real API keys.
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { authenticateApiKey, createApiKey } from '../../src/auth/api-keys.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_audit_${randomUUID().slice(0, 8)}`;
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let health: HealthMonitor;
let woo: FakeUpstream;
let ev: FakeUpstream;
let mcpUrl: string;
const who: Record<'alice' | 'bob', { userId: string; keyId: string; key: string }> = {} as never;
const SECRET_ARG = 'card 4111 1111 1111 1111';

async function client(key: string): Promise<Client> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}
const rows = async () => (await pool.query('SELECT * FROM audit_log ORDER BY id')).rows;
const reset = async () => { await pool.query('TRUNCATE audit_log'); };

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const hash = await hashPassword('audit-test-password');
  for (const name of ['alice', 'bob'] as const) {
    const [u] = await db.insert(users).values({ email: `${name}@example.test`, name, passwordHash: hash }).returning({ id: users.id });
    const k = await createApiKey(db, u!.id, `${name} key`, u!.id);
    who[name] = { userId: u!.id, keyId: k.id, key: k.key };
  }
  woo = await startFakeUpstream({ tools: ['echo', 'fail', 'boom', 'slow'] });
  ev = await startFakeUpstream({ tools: ['echo'] });
  await pool.query(`INSERT INTO upstreams (slug, name, url) VALUES ('woo', 'Woo', $1), ('everything', 'Ev', $2), ('off', 'Off', 'http://127.0.0.1:9/mcp')`, [woo.url, ev.url]);
  await pool.query(`UPDATE upstreams SET enabled = false WHERE slug = 'off'`);

  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  upstreamPool = new UpstreamPool({ key: loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') }), connectTimeoutMs: 1_000 });
  const loadUpstreams = () => listUpstreams(db);
  health = new HealthMonitor(upstreamPool, { loadUpstreams, checkTimeoutMs: 1_000 });
  registerMcp(app, { authenticate: (t) => authenticateApiKey(db, t), loadUpstreams, pool: upstreamPool, health, callTimeoutMs: 800,
    discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 2_000, health }), audit: dbAuditSink(db, app.log) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  mcpUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`;
});
afterAll(async () => {
  await app?.close();
  await health?.stop();
  await upstreamPool?.close();
  await woo?.close();
  // Dropping the database below ends connections pg may still be closing; that is teardown, not a failure.
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
beforeEach(reset);

describe('TC-AUTH-05 audit rows for every outcome (AUTH-13)', () => {
  it('ok, tool_error, error, timeout and rejected calls each leave one complete row; tools/list leaves one row', async () => {
    woo.setCallDelay(5_000); // longer than the 800 ms call budget
    const c = await client(who.alice.key);
    await c.listTools();
    await c.callTool({ name: 'woo__echo', arguments: { q: SECRET_ARG } });
    await c.callTool({ name: 'woo__fail', arguments: {} });
    await c.callTool({ name: 'woo__boom', arguments: {} });
    await c.callTool({ name: 'woo__slow', arguments: {} }); // 800 ms budget, the fake sleeps longer
    await c.callTool({ name: 'woo__nope', arguments: {} }).catch(() => {});
    await c.callTool({ name: 'ghost__echo', arguments: {} }).catch(() => {});
    await c.callTool({ name: 'off__echo', arguments: {} }).catch(() => {});
    await c.close();

    const r = await rows();
    const brief = r.map((x) => [x.method, x.upstream_slug, x.tool, x.outcome, x.error_code]);
    expect(brief).toEqual([
      ['tools/list', null, null, 'ok', null],
      ['tools/call', 'woo', 'echo', 'ok', null],
      ['tools/call', 'woo', 'fail', 'tool_error', null],
      ['tools/call', 'woo', 'boom', 'error', 'upstream_error'],
      ['tools/call', 'woo', 'slow', 'timeout', 'upstream_timeout'],
      ['tools/call', 'woo', 'woo__nope', 'rejected', 'unknown_tool'],
      ['tools/call', 'ghost', 'ghost__echo', 'rejected', 'unknown_tool'],
      ['tools/call', 'off', 'off__echo', 'rejected', 'upstream_disabled'],
    ]);
    const wooId = (await pool.query(`SELECT id FROM upstreams WHERE slug = 'woo'`)).rows[0].id;
    for (const x of r) {
      expect(x).toMatchObject({ user_id: who.alice.userId, api_key_id: who.alice.keyId, source: 'mcp' });
      expect(x.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(x.ts).toBeInstanceOf(Date);
      expect(x.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(r.filter((x) => x.upstream_slug === 'woo' && x.outcome !== 'rejected').every((x) => x.upstream_id === wooId)).toBe(true);
    expect(r.find((x) => x.tool === 'slow')!.duration_ms).toBeGreaterThanOrEqual(750);
    expect(new Set(r.map((x) => x.request_id)).size).toBe(r.length); // one request each (stateless)
    expect(JSON.stringify(r)).not.toContain(SECRET_ARG); // arguments are never stored
  });

  it('unreachable upstream → unreachable row', async () => {
    const c = await client(who.alice.key);
    await ev.close();
    await c.callTool({ name: 'everything__echo', arguments: {} }); // connection refused → marked unreachable
    await c.callTool({ name: 'everything__echo', arguments: {} }); // fail fast
    await c.close();
    expect((await rows()).map((x) => [x.upstream_slug, x.outcome, x.error_code])).toEqual([
      ['everything', 'unreachable', 'upstream_unreachable'], ['everything', 'unreachable', 'upstream_unreachable']]);
  });

  it('TC-AUTH-01 (audit): no key, wrong key and revoked key → 401 and a denied row without user or key', async () => {
    const post = (auth?: string, body: object = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'woo__echo', arguments: { q: SECRET_ARG } } }) =>
      fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
    const revoked = await createApiKey(db, who.bob.userId, 'to revoke', who.bob.userId);
    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [revoked.id]);
    for (const auth of [undefined, `Bearer mgw_${'Z'.repeat(43)}`, `Bearer ${revoked.key}`]) expect((await post(auth)).status).toBe(401);
    expect((await post(undefined, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(401);
    const r = await rows();
    expect(r.map((x) => [x.method, x.outcome, x.error_code, x.user_id, x.api_key_id, x.upstream_slug, x.tool])).toEqual([
      ['tools/call', 'denied', 'invalid_api_key', null, null, null, null],
      ['tools/call', 'denied', 'invalid_api_key', null, null, null, null],
      ['tools/call', 'denied', 'invalid_api_key', null, null, null, null],
      ['tools/list', 'denied', 'invalid_api_key', null, null, null, null],
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET_ARG);
    expect(JSON.stringify(r)).not.toContain(revoked.key);
  });
});

describe('TC-AUTH-11-1 attribution (AUTH-11)', () => {
  it('two users calling at the same time → every row carries the right user and key', async () => {
    const [a, b] = await Promise.all([client(who.alice.key), client(who.bob.key)]);
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? b : a).callTool({ name: 'woo__echo', arguments: { i } })));
    await Promise.all([a.close(), b.close()]);
    const r = await rows();
    expect(r).toHaveLength(10);
    const per = (u: 'alice' | 'bob') => r.filter((x) => x.user_id === who[u].userId);
    expect(per('alice')).toHaveLength(5);
    expect(per('bob')).toHaveLength(5);
    expect(per('alice').every((x) => x.api_key_id === who.alice.keyId)).toBe(true);
    expect(per('bob').every((x) => x.api_key_id === who.bob.keyId)).toBe(true);
  });

  it('an audit write failure is logged but does not fail the call', async () => {
    await pool.query('ALTER TABLE audit_log RENAME TO audit_log_away');
    try {
      const c = await client(who.alice.key);
      const r = await c.callTool({ name: 'woo__echo', arguments: {} });
      expect(r.isError).toBeFalsy();
      await c.close();
    } finally {
      await pool.query('ALTER TABLE audit_log_away RENAME TO audit_log');
    }
  });
});
