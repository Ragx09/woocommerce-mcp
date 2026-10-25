// BON-04 (REQ-SO-07): two gateway instances on one Postgres behave like two replicas behind Traefik.
// Per-key and per-user /mcp budgets and the chat's "one request per user at a time" are shared, whichever
// replica a request lands on. Real Postgres, fake upstream, stub LLM.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { createApiKey } from '../../src/auth/api-keys.js';
import { InternalTokenSigner, mcpAuthenticator } from '../../src/auth/internal-token.js';
import { hashPassword } from '../../src/auth/password.js';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { registerAuth } from '../../src/auth/routes.js';
import type { ChatCompletion } from '../../src/chat/llm.js';
import { registerChatRoutes } from '../../src/chat/routes.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { PgRateLimiter } from '../../src/ratelimit.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_repl_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'replicas-test-password';
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
let pool: pg.Pool;
let db: Db;
let woo: FakeUpstream;
const replicas: { app: FastifyInstance; url: string; upstreams: UpstreamPool }[] = [];
const ids: Record<'alice' | 'bob', string> = {} as never;
const cookies: Record<'alice' | 'bob', string> = {} as never;
let aliceKey1: string;
let aliceKey2: string;
let bobKey: string;

let gate: Promise<void> | null = null;
const stubLlm: ChatCompletion = async () => {
  if (gate) await gate;
  return { content: 'ok', toolCalls: [], finishReason: 'stop' };
};

async function replica(): Promise<void> {
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  const limiter = new PgRateLimiter(db); // each replica its own instance; only the database is shared
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN, limiter: new LoginLimiter({ store: limiter }) });
  const signer = new InternalTokenSigner();
  const upstreams = new UpstreamPool({ key, connectTimeoutMs: 1_000 });
  registerMcp(app, { authenticate: mcpAuthenticator(db, signer), loadUpstreams: () => listUpstreams(db), pool: upstreams,
    discovery: new ToolDiscovery(upstreams, { listTimeoutMs: 2_000 }), audit: dbAuditSink(db, app.log),
    rateLimit: { limiter, perKey: 3, perUser: 5, windowMs: 60_000 } });
  let port = 0;
  registerChatRoutes(app, { llm: stubLlm, signer, limiter, mcpUrl: () => `http://127.0.0.1:${port}/mcp`, limits: { perWindow: 50, windowMs: 60_000 } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
  replicas.push({ app, url: `http://127.0.0.1:${port}`, upstreams });
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const hash = await hashPassword(PW);
  for (const name of ['alice', 'bob'] as const) {
    const [u] = await db.insert(users).values({ email: `${name}@example.test`, name, passwordHash: hash }).returning({ id: users.id });
    ids[name] = u!.id;
  }
  aliceKey1 = (await createApiKey(db, ids.alice, 'one', ids.alice)).key;
  aliceKey2 = (await createApiKey(db, ids.alice, 'two', ids.alice)).key;
  bobKey = (await createApiKey(db, ids.bob, 'bob', ids.bob)).key;
  woo = await startFakeUpstream({ tools: ['list_orders'] });
  await pool.query(`INSERT INTO upstreams (slug, name, url) VALUES ('woo', 'Woo', $1)`, [woo.url]);
  await replica();
  await replica();
  for (const name of ['alice', 'bob'] as const) {
    const res = await replicas[0]!.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
      payload: { email: `${name}@example.test`, password: PW } });
    cookies[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
});
afterAll(async () => {
  for (const r of replicas) { await r.app.close(); await r.upstreams.close(); }
  await woo?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

/** One stateless JSON-RPC request to replica `i`. */
const rpc = (i: number, bearer: string, method: string, params: object = {}) => fetch(`${replicas[i]!.url}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
const chat = (i: number, who: 'alice' | 'bob') => fetch(`${replicas[i]!.url}/api/chat`, {
  method: 'POST', headers: { origin: ORIGIN, cookie: cookies[who], 'content-type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});

describe('TC-BON-04 limits shared by two replicas', () => {
  it('TC-BON-04-1: per-key and per-user /mcp budgets hold across replicas; others unaffected; refusals audited', async () => {
    // Key budget 3: alternate replicas — the 4th request is refused wherever it lands.
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await rpc(i % 2, aliceKey1, i % 2 ? 'tools/call' : 'tools/list', i % 2 ? { name: 'woo__list_orders', arguments: {} } : {})).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const refused = await rpc(0, aliceKey1, 'tools/list');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(50);
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' });
    // initialize/notifications are not counted: a client can still connect.
    expect((await rpc(1, aliceKey1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).status).toBe(200);

    // User budget 5 across alice's keys: 5 hits used above (incl. the refusals) → her second key is refused too.
    expect((await rpc(1, aliceKey2, 'tools/list')).status).toBe(429);
    // Bob has his own budget.
    expect((await rpc(0, bobKey, 'tools/list')).status).toBe(200);
    expect((await rpc(1, bobKey, 'tools/list')).status).toBe(200);

    const rows = (await pool.query(`SELECT user_id, outcome, error_code FROM audit_log WHERE error_code = 'rate_limited'`)).rows;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.user_id === ids.alice && r.outcome === 'rejected')).toBe(true);
  });

  it('TC-BON-04-1a: the dashboard chat is not blocked by its user\'s exhausted /mcp budget (it has its own limits)', async () => {
    expect((await rpc(0, aliceKey1, 'tools/list')).status).toBe(429); // alice is over her API budget (test above)
    const res = await chat(1, 'alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reply: 'ok' });
  });

  it('TC-BON-04-1b: one chat per user at a time across replicas; other users and later requests are fine', async () => {
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const first = chat(0, 'alice');
    await new Promise((r) => setTimeout(r, 300)); // alice's request on replica 0 is inside the LLM call
    const second = await chat(1, 'alice');
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: 'chat_busy' });
    const bob = chat(1, 'bob');
    open();
    expect((await bob).status).toBe(200);
    expect((await first).status).toBe(200);
    gate = null;
    expect((await chat(1, 'alice')).status).toBe(200); // lease released
    expect((await pool.query('SELECT count(*)::int AS n FROM leases')).rows[0].n).toBe(0);
  });

  it('TC-BON-04-1c: leases expire by themselves and are released only by their holder; windows restart after they end', async () => {
    const a = new PgRateLimiter(db);
    const b = new PgRateLimiter(db);
    const releaseA = await a.lease('t:lease', 300);
    expect(releaseA).not.toBeNull();
    expect(await b.lease('t:lease', 300)).toBeNull();
    await new Promise((r) => setTimeout(r, 400)); // A's holder "crashed": the lease expires
    const releaseB = await b.lease('t:lease', 10_000);
    expect(releaseB).not.toBeNull();
    await releaseA!(); // late release by the old holder must not free B's lease
    expect(await a.lease('t:lease', 300)).toBeNull();
    await releaseB!();
    expect(await a.lease('t:lease', 300)).not.toBeNull();

    expect((await a.hit('t:win', 2, 400)).allowed).toBe(true);
    expect((await b.hit('t:win', 2, 400)).allowed).toBe(true);
    const over = await a.hit('t:win', 2, 400);
    expect(over).toMatchObject({ allowed: false, hits: 3, retryAfterS: 1 });
    await new Promise((r) => setTimeout(r, 450));
    expect(await b.hit('t:win', 2, 400)).toMatchObject({ allowed: true, hits: 1 });
  });

  it('TC-BON-04-1d (F-AUTH-2): failed logins count across replicas; peek does not count; a success resets the account', async () => {
    const login = (i: number, email: string, password: string) => fetch(`${replicas[i % 2]!.url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const email = 'nobody@example.test';
    for (let i = 0; i < 5; i++) expect((await login(i, email, 'wrong')).status).toBe(401); // alternating replicas
    for (const i of [0, 1]) {
      const r = await login(i, email, 'wrong');
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    const p = new PgRateLimiter(db);
    expect(await p.peek('t:peek', 1, 60_000)).toMatchObject({ allowed: true, hits: 0 });
    await p.hit('t:peek', 1, 60_000);
    expect(await p.peek('t:peek', 1, 60_000)).toMatchObject({ allowed: false, hits: 1 });
    await p.reset('t:peek');
    expect(await p.peek('t:peek', 1, 60_000)).toMatchObject({ allowed: true, hits: 0 });
  });
});
