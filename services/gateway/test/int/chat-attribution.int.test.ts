// TC-UI-17-1 (REQ-CHAT-03, REQ-DOD-11): chat calls are audited under the user who asked, also when several
// users chat at the same time and while others use their API keys on /mcp. Real Postgres, real sessions, the
// real /mcp over loopback with the internal token (UI-15), fake upstreams, a stub LLM that holds every request
// until all users are in flight (so the agents' tokens and tool calls really interleave).
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { InternalTokenSigner, mcpAuthenticator } from '../../src/auth/internal-token.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import type { ChatCompletion } from '../../src/chat/llm.js';
import { registerChatRoutes } from '../../src/chat/routes.js';
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
const dbName = `gw_chatattr_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'chat-attribution-password';
const NAMES = ['alice', 'bob', 'carol'] as const; // alice is admin, the others members
type Who = (typeof NAMES)[number];
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let woo: FakeUpstream;
let ev: FakeUpstream;
const cookie = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;

/**
 * Stub LLM. A user turn "<tool> <marker>" → call the offered tool containing <tool> with {text: marker};
 * after the tool result → answer with it. First rounds wait at a barrier until `expected` requests arrived.
 */
let expected = 1;
let arrived = 0;
let release: () => void = () => {};
let barrier = Promise.resolve();
function armBarrier(n: number): void {
  expected = n;
  arrived = 0;
  barrier = new Promise((r) => { release = r; });
}
const stubLlm: ChatCompletion = async ({ messages, tools }) => {
  const last = messages.at(-1)!;
  if (last.role === 'tool') return { content: `answer: ${last.content}`, toolCalls: [], finishReason: 'stop' };
  if (++arrived >= expected) release();
  await barrier;
  const [want, marker] = String(last.content).split(' ');
  const tool = tools.find((t) => t.function.name.endsWith(`__${want}`));
  if (!tool) return { content: 'no tool', toolCalls: [], finishReason: 'stop' };
  return { content: null, finishReason: 'tool_calls',
    toolCalls: [{ id: 'c1', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ text: marker }) } }] };
};

const chat = (who: Who, text: string) => app.inject({
  method: 'POST', url: '/api/chat', headers: { origin: ORIGIN, cookie: cookie[who] }, payload: { messages: [{ role: 'user', content: text }] },
});
/** An external MCP client call with an API key (stateless JSON-RPC, like Claude Code / Inspector). */
const mcpCall = (key: string, tool: string, text: string) => app.inject({
  method: 'POST', url: '/mcp',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { text } } },
});
interface Row { user_id: string | null; api_key_id: string | null; source: string; method: string; upstream_slug: string | null; tool: string | null; outcome: string }
const callRows = async (): Promise<Row[]> => (await pool.query(
  `SELECT user_id, api_key_id, source, method, upstream_slug, tool, outcome FROM audit_log WHERE method = 'tools/call' ORDER BY id`)).rows;
const whoIs = (id: string | null) => NAMES.find((n) => ids[n] === id) ?? `unknown:${id}`;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const hash = await hashPassword(PW);
  for (const name of NAMES) {
    const [u] = await db.insert(users).values({ email: `${name}@example.test`, name, passwordHash: hash, role: name === 'alice' ? 'admin' : 'member' })
      .returning({ id: users.id });
    ids[name] = u!.id;
  }
  woo = await startFakeUpstream({ tools: ['list_orders', 'fail'] });
  ev = await startFakeUpstream({ tools: ['echo'] });
  await pool.query(`INSERT INTO upstreams (slug, name, url) VALUES ('woo', 'Woo', $1), ('everything', 'Ev', $2)`, [woo.url, ev.url]);

  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN }); // also /api/keys and /api/audit
  const signer = new InternalTokenSigner();
  upstreamPool = new UpstreamPool({ key: loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') }), connectTimeoutMs: 1_000 });
  registerMcp(app, { authenticate: mcpAuthenticator(db, signer), loadUpstreams: () => listUpstreams(db), pool: upstreamPool,
    discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 2_000 }), audit: dbAuditSink(db, app.log) });
  let port = 0;
  registerChatRoutes(app, { llm: stubLlm, signer, mcpUrl: () => `http://127.0.0.1:${port}/mcp`, limits: { perWindow: 50, windowMs: 60_000 } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
  for (const name of NAMES) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${name}@example.test`, password: PW } });
    cookie[name] = String(res.headers['set-cookie']).split(';')[0]!;
  }
});
afterAll(async () => {
  await app?.close();
  await upstreamPool?.close();
  await woo?.close();
  await ev?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
beforeEach(async () => {
  armBarrier(1);
  await pool.query('TRUNCATE audit_log');
});

describe('TC-UI-17-1 chat attribution', () => {
  it('three users chatting at the same time: every tool call is audited under the user who asked', async () => {
    for (let round = 0; round < 3; round++) {
      armBarrier(NAMES.length); // all three agents are in flight before any of them calls a tool
      const res = await Promise.all(NAMES.map((n, i) => chat(n, `${i % 2 ? 'echo' : 'list_orders'} ${n}-${round}`)));
      for (const r of res) expect(r.statusCode).toBe(200);
      // each user got the answer to their own question (the fake upstream echoes the arguments)
      res.forEach((r, i) => expect(r.json().reply).toContain(`${NAMES[i]}-${round}`));
    }
    const rows = await callRows();
    expect(rows).toHaveLength(9);
    for (const r of rows) {
      expect(r).toMatchObject({ source: 'chat', api_key_id: null, outcome: 'ok' });
    }
    // the per-user counts and upstreams match what each one asked
    const by = (n: Who) => rows.filter((r) => r.user_id === ids[n]);
    expect(by('alice').map((r) => r.upstream_slug)).toEqual(['woo', 'woo', 'woo']);
    expect(by('bob').map((r) => r.upstream_slug)).toEqual(['everything', 'everything', 'everything']);
    expect(by('carol').map((r) => r.upstream_slug)).toEqual(['woo', 'woo', 'woo']);
  });

  it('chat and external API-key calls at the same time keep their own user, source and key', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/keys', headers: { origin: ORIGIN, cookie: cookie.bob }, payload: { name: 'bob laptop' } });
    expect(created.statusCode).toBe(201);
    const { id: bobKeyId, key: bobKey } = created.json() as { id: string; key: string };

    armBarrier(2);
    const [a, c, ...ext] = await Promise.all([
      chat('alice', 'list_orders alice-chat'),
      chat('carol', 'echo carol-chat'),
      mcpCall(bobKey, 'woo__list_orders', 'bob-ext-1'),
      mcpCall(bobKey, 'everything__echo', 'bob-ext-2'),
    ]);
    expect([a.statusCode, c.statusCode, ...ext.map((r) => r.statusCode)]).toEqual([200, 200, 200, 200]);

    const rows = await callRows();
    const summary = rows.map((r) => `${whoIs(r.user_id)} ${r.source} ${r.api_key_id ? 'key' : 'nokey'} ${r.upstream_slug}/${r.tool}`).sort();
    expect(summary).toEqual([
      'alice chat nokey woo/list_orders',
      'bob mcp key everything/echo',
      'bob mcp key woo/list_orders',
      'carol chat nokey everything/echo',
    ]);
    expect(rows.filter((r) => r.api_key_id).every((r) => r.api_key_id === bobKeyId)).toBe(true);
  });

  it('a failed tool call in the chat is still audited under the user', async () => {
    const res = await chat('carol', 'fail carol');
    expect(res.statusCode).toBe(200);
    expect(res.json().toolCalls).toMatchObject([{ name: 'woo__fail', ok: false }]);
    expect(await callRows()).toEqual([
      { user_id: ids.carol, api_key_id: null, source: 'chat', method: 'tools/call', upstream_slug: 'woo', tool: 'fail', outcome: 'tool_error' },
    ]);
  });

  it("the admin's audit view filtered by user shows exactly that user's chat calls", async () => {
    armBarrier(2);
    await Promise.all([chat('alice', 'list_orders a'), chat('bob', 'echo b')]);
    await chat('bob', 'list_orders b2');
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/audit?${q}`, headers: { cookie: cookie.alice } });
    const bobs = (await get(`user=${ids.bob}&source=chat`)).json().items as { user: { id: string; email: string }; method: string; tool: string | null; source: string }[];
    const calls = bobs.filter((i) => i.method === 'tools/call');
    expect(calls.map((i) => i.tool).sort()).toEqual(['echo', 'list_orders']);
    expect(bobs.every((i) => i.user.id === ids.bob && i.user.email === 'bob@example.test' && i.source === 'chat')).toBe(true);
    // a member cannot read the audit log at all (server-side, AUTH-10)
    expect((await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookie.bob } })).statusCode).toBe(403);
  });
});
