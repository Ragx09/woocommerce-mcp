// TC-INT-06 (GW-12) against a real Postgres (scripts/gateway-db-int.sh): each upstream receives its own
// stored credential on every request and never the client's key; the credential is encrypted at rest
// and appears in no /mcp response and no gateway log line (debug level included).
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { encryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { upstreams } from '../../src/db/schema.js';
import { loggerOptions } from '../../src/logger.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';
import { staticKeyAuth } from '../helpers/static-auth.js';

const CLIENT_KEY = `client-key-${randomBytes(16).toString('hex')}`;
const WOO_TOKEN = `woo-secret-${randomBytes(12).toString('hex')}`;
const GH_PAT = `github_pat_${randomBytes(12).toString('hex')}`;
const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_cred_${randomUUID().slice(0, 8)}`;
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
});
afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('TC-INT-06 credential injection (GW-12)', () => {
  it('stored credential on every upstream request, client key never forwarded, secrets in no response or log', async () => {
    const woo = await startFakeUpstream({ tools: ['echo', 'fail'] }); // stateless, like woo-mcp
    const gh = await startFakeUpstream({ tools: ['echo'], sessionful: true }); // sessionful, like a remote server
    const plain = await startFakeUpstream({ tools: ['echo'] });
    await db.insert(upstreams).values({ slug: 'woo', name: 'Woo', url: woo.url, authType: 'header', authHeader: 'X-Internal-Token',
      credentialEnc: encryptCredential(key, 'woo', WOO_TOKEN) });
    await db.insert(upstreams).values({ slug: 'github', name: 'GitHub', url: gh.url, authType: 'bearer',
      credentialEnc: encryptCredential(key, 'github', GH_PAT) });
    await db.insert(upstreams).values({ slug: 'plain', name: 'Plain', url: plain.url });

    // At rest: only ciphertext in the database.
    const raw = JSON.stringify((await pool.query('SELECT * FROM upstreams')).rows);
    for (const s of [WOO_TOKEN, GH_PAT]) expect(raw).not.toContain(s);

    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const app = buildApp(loadConfig({}), { logger: { ...loggerOptions('trace'), stream } });
    const upstreamPool = new UpstreamPool({ key, connectTimeoutMs: 1_000, log: app.log });
    const loadUpstreams = () => listUpstreams(db);
    const health = new HealthMonitor(upstreamPool, { loadUpstreams, log: app.log });
    registerMcp(app, { authenticate: staticKeyAuth(CLIENT_KEY), loadUpstreams, pool: upstreamPool, health,
      discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 2_000, health, log: app.log }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const c = new Client({ name: 'test', version: '1' });
    try {
      const { port } = app.server.address() as { port: number };
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${CLIENT_KEY}`, 'x-internal-token': 'client-spoof' } } }));

      const responses: unknown[] = [];
      responses.push(await c.listTools());
      responses.push(await c.callTool({ name: 'woo__echo', arguments: { q: 1 } }));
      responses.push(await c.callTool({ name: 'woo__fail', arguments: {} }));
      responses.push(await c.callTool({ name: 'github__echo', arguments: {} }));
      responses.push(await c.callTool({ name: 'plain__echo', arguments: {} }));
      await health.checkAll(); // pings: also upstream requests
      gh.restart(); // stale session → the pool reconnects; the new session must carry the PAT too
      responses.push(await c.listTools());
      responses.push(await c.callTool({ name: 'github__echo', arguments: {} }));

      // Every request each upstream received carries exactly its own credential.
      expect(woo.headers.length).toBeGreaterThanOrEqual(4);
      expect(gh.headers.length).toBeGreaterThanOrEqual(6);
      for (const h of woo.headers) {
        expect(h['x-internal-token']).toBe(WOO_TOKEN); // ours, not the client's spoofed header
        expect(h.authorization).toBeUndefined();
      }
      for (const h of gh.headers) {
        expect(h.authorization).toBe(`Bearer ${GH_PAT}`);
        expect(h['x-internal-token']).toBeUndefined();
      }
      for (const h of plain.headers) {
        expect(h.authorization).toBeUndefined();
        expect(h['x-internal-token']).toBeUndefined();
      }
      const allSent = JSON.stringify([woo.headers, gh.headers, plain.headers]);
      expect(allSent).not.toContain(CLIENT_KEY);
      expect(allSent).not.toContain('client-spoof');
      expect(JSON.stringify(woo.headers)).not.toContain(GH_PAT);
      expect(JSON.stringify([gh.headers, plain.headers])).not.toContain(WOO_TOKEN);

      // Nothing secret goes back to the client or into the logs.
      const out = JSON.stringify(responses);
      const log = lines.join('');
      expect(log).toContain('tools/call'); // the log stream really captured the requests
      for (const s of [WOO_TOKEN, GH_PAT, CLIENT_KEY]) {
        expect(out).not.toContain(s);
        expect(log).not.toContain(s);
      }
    } finally {
      await c.close();
      await health.stop();
      await app.close();
      await upstreamPool.close();
      await Promise.all([woo.close(), gh.close(), plain.close()]);
    }
  });
});
