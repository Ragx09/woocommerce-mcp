// TC-AUTH-02-1/2 (AUTH-02) against a real Postgres: admin seed + POST /api/auth/login.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { sessionUser } from '../../src/auth/sessions.js';
import { sha256Hex } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { sessions, users } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_login_${randomUUID().slice(0, 8)}`;
const PW = 'first-admin-password-123';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: true, limiter: new LoginLimiter({ perAccount: 5, perIp: 50 }) });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const login = (email: string, password: string, ip = '10.0.0.1') =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: ip });

describe('admin seed (AUTH-02)', () => {
  it('TC-AUTH-02-3: created once from the Secret values; never overwrites an existing admin', async () => {
    expect(await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW })).toBe('created');
    expect(await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: 'a-different-password' })).toBe('exists');
    expect(await seedAdmin(db, { email: 'other@example.test', name: 'X', password: 'a-different-password' })).toBe('exists');
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'admin@example.test', role: 'admin', disabledAt: null });
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });
});

describe('POST /api/auth/login (AUTH-02)', () => {
  it('TC-AUTH-02-1: right password → 200, user, httpOnly SameSite=Strict Secure cookie; only the token hash is stored', async () => {
    const res = await login('  ADMIN@example.test ', PW);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: expect.any(String), email: 'admin@example.test', name: 'Admin', role: 'admin' } });
    expect(JSON.stringify(res.json())).not.toMatch(/argon2|password/i);
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/^sid=[A-Za-z0-9_-]{43};/);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=43200']) expect(set).toContain(attr);
    const token = set.slice(4, 47);
    const rows = await db.select().from(sessions);
    expect(rows.map((r) => r.idHash)).toContain(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await sessionUser(db, token)).toMatchObject({ email: 'admin@example.test', role: 'admin' });
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBe(12 * 3600 * 1000);
  });

  it('TC-AUTH-02-2: wrong password, unknown email and disabled user → the same 401, no cookie', async () => {
    const bodies = [];
    for (const [email, pw] of [['admin@example.test', 'wrong-password-xyz'], ['nobody@example.test', PW]] as const) {
      const res = await login(email, pw, '10.0.0.2');
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      bodies.push(res.body);
    }
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: 'invalid_credentials', message: 'wrong email or password' });

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, 'admin@example.test'));
    const res = await login('admin@example.test', PW, '10.0.0.3');
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(bodies[0]);
    await db.update(users).set({ disabledAt: null }).where(eq(users.email, 'admin@example.test'));
  });

  it('TC-AUTH-02-4: 5 wrong passwords → 429 with Retry-After, even for the right password; another IP still logs in', async () => {
    for (let i = 0; i < 5; i++) expect((await login('admin@example.test', `guess-${i}-xxxxxx`, '10.9.9.9')).statusCode).toBe(401);
    const blocked = await login('admin@example.test', PW, '10.9.9.9');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(800);
    expect(blocked.json().error).toBe('rate_limited');
    expect((await login('admin@example.test', PW, '10.8.8.8')).statusCode).toBe(200);
  });

  it('malformed bodies → 400 validation_failed, nothing else leaks', async () => {
    for (const payload of [{}, { email: 'a@b' }, { email: 'a@b.c', password: 'x', role: 'admin' }, { email: 'a@b.c', password: 'p'.repeat(300) }]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
  });
});
