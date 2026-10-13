// AUTH-14: GET /api/audit — admin only, filters, newest first, cursor pagination, safe fields only.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createApiKey } from '../../src/auth/api-keys.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_auditq_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'audit-query-password';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let alice: string;
let keyPrefix: string;

const get = (qs: string, cookie = adminCookie) => app.inject({ method: 'GET', url: `/api/audit${qs}`, headers: { cookie } });

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  [{ id: alice }] = await db.insert(users).values({ email: 'alice@example.test', name: 'Alice', passwordHash: await hashPassword(PW) })
    .returning({ id: users.id }) as [{ id: string }];
  const k = await createApiKey(db, alice, 'laptop', alice);
  keyPrefix = k.prefix;
  // 30 rows: alternating upstreams, outcomes; timestamps one minute apart; plus denied rows without a user.
  for (let i = 0; i < 30; i++) {
    await pool.query(`INSERT INTO audit_log (ts, request_id, user_id, api_key_id, source, method, upstream_slug, tool, duration_ms, outcome, error_code)
      VALUES ($1, $2, $3, $4, $5, 'tools/call', $6, $7, $8, $9, $10)`,
    [new Date(Date.UTC(2026, 9, 13, 10, i)), randomUUID(), alice, k.id, i % 5 === 0 ? 'chat' : 'mcp',
      i % 2 ? 'github' : 'woo', i % 2 ? 'get_me' : 'list_orders', 10 + i, i % 3 === 0 ? 'timeout' : 'ok', i % 3 === 0 ? 'upstream_timeout' : null]);
  }
  await pool.query(`INSERT INTO audit_log (ts, source, method, duration_ms, outcome, error_code) VALUES (now(), 'mcp', 'tools/call', 1, 'denied', 'invalid_api_key')`);
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN },
    payload: { email, password: PW } })).headers['set-cookie']).split(';')[0]!;
  adminCookie = await login('admin@example.test');
  memberCookie = await login('alice@example.test');
});
afterAll(async () => {
  await app?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('GET /api/audit (AUTH-14)', () => {
  it('admin: newest first, default 50, display fields only (user, key prefix — never hashes)', async () => {
    const res = await get('');
    expect(res.statusCode).toBe(200);
    const { items, nextCursor } = res.json();
    expect(items).toHaveLength(31);
    expect(nextCursor).toBeNull();
    expect(items[0]).toMatchObject({ outcome: 'denied', user: null, keyPrefix: null, errorCode: 'invalid_api_key' });
    expect(items[1]).toEqual({ id: expect.any(Number), ts: '2026-10-13T10:29:00.000Z', requestId: expect.any(String), source: 'mcp',
      method: 'tools/call', upstream: 'github', tool: 'get_me', durationMs: 39, outcome: 'ok', errorCode: null, keyPrefix,
      user: { id: alice, email: 'alice@example.test', name: 'Alice' } });
    expect(res.body).not.toMatch(/key_hash|keyHash|password/);
  });

  it('filters: user, upstream, outcome, source, time range — combined', async () => {
    const n = async (qs: string) => (await get(qs)).json().items.length;
    expect(await n(`?user=${alice}`)).toBe(30);
    expect(await n('?upstream=woo')).toBe(15);
    expect(await n('?outcome=timeout')).toBe(10);
    expect(await n('?outcome=denied')).toBe(1);
    expect(await n('?source=chat')).toBe(6);
    expect(await n('?from=2026-10-13T10:10:00Z&to=2026-10-13T10:19:00Z')).toBe(10);
    expect(await n('?upstream=woo&outcome=timeout&from=2026-10-13T10:00:00Z&to=2026-10-13T10:29:59Z')).toBe(5);
    expect(await n(`?user=${randomUUID()}`)).toBe(0);
  });

  it('cursor pagination: pages do not overlap, cover everything, and stay stable when new rows arrive', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: { items: { id: number }[]; nextCursor: string | null } = (await get(`?limit=7${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...body.items.map((i) => i.id));
      if (pages === 0) await pool.query(`INSERT INTO audit_log (source, method, duration_ms, outcome) VALUES ('mcp', 'tools/list', 1, 'ok')`);
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(5); // 31 rows / 7
    expect(new Set(seen).size).toBe(31);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it('member → 403, anonymous → 401; bad filters → 400', async () => {
    expect((await get('', memberCookie)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);
    for (const qs of ['?user=alice', '?outcome=maybe', '?limit=0', '?limit=500', '?from=yesterday', '?cursor=-1', '?cursor=abc',
      '?upstream=../etc', '?sql=1', '?from=2026-10-14T00:00:00Z&to=2026-10-13T00:00:00Z']) {
      expect((await get(qs)).statusCode, qs).toBe(400);
    }
  });
});
