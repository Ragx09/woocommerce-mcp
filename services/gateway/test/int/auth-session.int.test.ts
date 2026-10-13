// TC-AUTH-03-1/2 (AUTH-03) against a real Postgres: /api/me with the session cookie, logout, expiry,
// disabled users, and the Origin check on mutating /api requests.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { requireRole, requireSession } from '../../src/auth/guard.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { sessions, users } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_sess_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'session-test-password';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  await db.insert(users).values({ email: 'member@example.test', name: 'Member', role: 'member', passwordHash: await hashPassword(PW) });
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  // A stand-in admin-only mutation, to prove the guards compose (the real routes come with AUTH-04+).
  app.post('/api/admin-only', { preHandler: [requireSession(db), requireRole('admin')] }, async () => ({ ok: true }));
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

async function loginAs(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PW } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!; // "sid=…"
}
const me = (cookie?: string) => app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} });

describe('sessions (AUTH-03)', () => {
  it('TC-AUTH-03-1: /api/me works with the cookie and only with it', async () => {
    const cookie = await loginAs('member@example.test');
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: expect.any(String), email: 'member@example.test', name: 'Member', role: 'member' });
    for (const bad of [undefined, 'sid=', 'sid=forged-token-value', `sid=${'x'.repeat(500)}`]) {
      const r = await me(bad);
      expect(r.statusCode, String(bad).slice(0, 20)).toBe(401);
      expect(r.json()).toEqual({ error: 'unauthenticated', message: 'log in first' });
    }
  });

  it('logout deletes the session (the old cookie stops working) and clears the cookie; repeat is harmless', async () => {
    const cookie = await loginAs('member@example.test');
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: ORIGIN } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/^sid=; Max-Age=0; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict/);
    expect((await me(cookie)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: ORIGIN } })).statusCode).toBe(204);
  });

  it('expired session and disabled user → 401 on the next request', async () => {
    const cookie = await loginAs('member@example.test');
    expect((await me(cookie)).statusCode).toBe(200);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, 'member@example.test'));
    expect((await me(cookie)).statusCode).toBe(401);
    await db.update(users).set({ disabledAt: null }).where(eq(users.email, 'member@example.test'));
    expect((await me(cookie)).statusCode).toBe(200);
    await db.update(sessions).set({ createdAt: new Date(Date.now() - 13 * 3600_000), expiresAt: new Date(Date.now() - 1000) });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('role guard: member → 403, admin → 200 (server-side, whatever the UI shows)', async () => {
    const m = await loginAs('member@example.test');
    const a = await loginAs('admin@example.test');
    const post = (cookie: string) => app.inject({ method: 'POST', url: '/api/admin-only', headers: { cookie, origin: ORIGIN } });
    expect((await post(m)).statusCode).toBe(403);
    expect((await post(m)).json()).toEqual({ error: 'forbidden', message: 'not allowed for your role' });
    expect((await post(a)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin-only', headers: { origin: ORIGIN } })).statusCode).toBe(401);
  });

  it('TC-AUTH-03-2: cross-origin POST rejected before any work — even with a valid admin cookie', async () => {
    const a = await loginAs('admin@example.test');
    const cases: Array<[Record<string, string>, number]> = [
      [{ origin: 'https://evil.example' }, 403],
      [{ origin: 'http://app.example.test' }, 403], // scheme matters
      [{ origin: 'https://app.example.test.evil.example' }, 403],
      [{ origin: 'null' }, 403], // sandboxed iframe / file://
      [{ 'sec-fetch-site': 'cross-site' }, 403],
      [{ 'sec-fetch-site': 'same-site' }, 403], // another *.example.test subdomain is not us
      [{ origin: ORIGIN }, 200],
      [{ 'sec-fetch-site': 'same-origin' }, 200],
      [{}, 200], // no browser headers: not a browser, so no ambient-cookie CSRF
    ];
    for (const [headers, want] of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/admin-only', headers: { cookie: a, ...headers } });
      expect(res.statusCode, JSON.stringify(headers)).toBe(want);
      if (want === 403) expect(res.json()).toEqual({ error: 'forbidden', message: 'cross-origin request refused' });
    }
    // Login CSRF: a foreign page cannot log the victim into the attacker's account.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' },
      payload: { email: 'admin@example.test', password: PW } });
    expect(login.statusCode).toBe(403);
    expect(login.headers['set-cookie']).toBeUndefined();
    // GET is not a state change: a cross-origin GET is answered (the browser keeps the response from the page via CORS).
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a, origin: 'https://evil.example' } })).statusCode).toBe(200);
  });
});
