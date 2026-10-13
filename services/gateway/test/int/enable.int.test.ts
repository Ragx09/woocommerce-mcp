// TC-INT-05 (GW-11) against a real Postgres (scripts/gateway-db-int.sh): disabling an upstream hides its
// tools and rejects calls on every replica from the next request on, and closes the pooled connection.
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { upstreams } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams, setUpstreamEnabled } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const DEV_KEY = 'k'.repeat(40);
const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_enable_${randomUUID().slice(0, 8)}`;
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
let pool: pg.Pool;
let db: Db;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
});
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); await pool.query('TRUNCATE upstreams'); });
afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

async function fake(tools: string[]): Promise<FakeUpstream> {
  const f = await startFakeUpstream({ tools, sessionful: true });
  cleanup.push(f.close);
  return f;
}

/** One gateway replica reading the shared DB, as in the cluster. */
async function replica() {
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  const upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 1_000 });
  const loadUpstreams = () => listUpstreams(db);
  const health = new HealthMonitor(upstreamPool, { loadUpstreams, checkTimeoutMs: 2_000 });
  registerMcp(app, {
    devKey: DEV_KEY, loadUpstreams, pool: upstreamPool, health,
    discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 2_000, health }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.unshift(async () => { await health.stop(); await app.close(); await upstreamPool.close(); });
  const { port } = app.server.address() as { port: number };
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${DEV_KEY}` } } }));
  cleanup.unshift(() => c.close());
  return { c, pool: upstreamPool, health };
}

const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const callError = async (c: Client, name: string) => {
  try { await c.callTool({ name, arguments: {} }); } catch (e) { return e as McpError; }
  throw new Error('call was not rejected');
};

describe('TC-INT-05 enable/disable (GW-11)', () => {
  it('disable → hidden and rejected on every replica, nothing sent upstream, connection closed; enable → back', async () => {
    const woo = await fake(['echo']);
    const ev = await fake(['echo', 'add']);
    await db.insert(upstreams).values([
      { slug: 'woo', name: 'Woo', url: woo.url }, // same created_at → listed by slug
      { slug: 'everything', name: 'Everything', url: ev.url },
    ]);
    const evRow = (await listUpstreams(db)).find((u) => u.slug === 'everything')!;
    const a = await replica();
    const b = await replica();
    for (const r of [a, b]) {
      expect(await names(r.c)).toEqual(['everything__echo', 'everything__add', 'woo__echo']);
      expect((await r.c.callTool({ name: 'everything__add', arguments: {} })).isError).toBeFalsy();
      expect(r.pool.isConnected(evRow.id)).toBe(true);
    }

    expect((await setUpstreamEnabled(db, evRow.id, false))?.enabled).toBe(false);
    const sentBefore = ev.headers.length;
    for (const r of [a, b]) {
      expect(await names(r.c)).toEqual(['woo__echo']); // next request, no restart, no cache wait
      const err = await callError(r.c, 'everything__add');
      expect(err.code).toBe(-32602);
      expect(err.message).toContain('upstream everything is disabled');
      expect(err.data).toEqual({ code: 'upstream_disabled' });
      expect(r.pool.isConnected(evRow.id)).toBe(false); // pooled client closed
      expect((await r.c.callTool({ name: 'woo__echo', arguments: {} })).isError).toBeFalsy(); // others fine
    }
    expect(ev.headers.length).toBe(sentBefore); // the disabled upstream received nothing
    await a.health.checkAll();
    expect(a.health.get((await listUpstreams(db)).find((u) => u.slug === 'everything')!).status).toBe('disabled');
    expect(ev.headers.length).toBe(sentBefore); // not even health checks

    await setUpstreamEnabled(db, evRow.id, true);
    for (const r of [a, b]) {
      expect(await names(r.c)).toEqual(['everything__echo', 'everything__add', 'woo__echo']);
      expect((await r.c.callTool({ name: 'everything__echo', arguments: {} })).isError).toBeFalsy();
    }
  });

  it('a replica with no /mcp traffic still closes the connection on its next health round', async () => {
    const ev = await fake(['echo']);
    await db.insert(upstreams).values({ slug: 'everything', name: 'Everything', url: ev.url });
    const row = (await listUpstreams(db))[0]!;
    const r = await replica();
    await r.health.checkAll();
    expect(r.pool.isConnected(row.id)).toBe(true);
    await setUpstreamEnabled(db, row.id, false);
    await r.health.checkAll();
    expect(r.pool.isConnected(row.id)).toBe(false);
    expect(r.pool.upstreams()).toEqual([]);
  });

  it('unknown id → undefined, nothing changed', async () => {
    expect(await setUpstreamEnabled(db, randomUUID(), false)).toBeUndefined();
  });
});
