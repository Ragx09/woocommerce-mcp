// TC-AUTH-03 (invite flow: single use, expiring) and TC-AUTH-05-1 (accept), real Postgres. AUTH-04/05.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { sha256Hex } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { invites, users } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_inv_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'invite-test-password';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

const post = (url: string, payload: object, cookie?: string) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
async function login(email: string, password = PW) {
  const res = await post('/api/auth/login', { email, password });
  return { status: res.statusCode, cookie: String(res.headers['set-cookie']).split(';')[0]! };
}
async function invite(email: string, role?: 'admin' | 'member') {
  const res = await post('/api/invites', role ? { email, role } : { email }, adminCookie);
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { ...body, token: body.inviteUrl.split('#')[1] as string };
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'admin@example.test', name: 'Admin', password: PW });
  await db.insert(users).values({ email: 'member@example.test', name: 'M', role: 'member', passwordHash: await hashPassword(PW) });
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: true, publicOrigin: ORIGIN });
  adminCookie = (await login('admin@example.test')).cookie;
  memberCookie = (await login('member@example.test')).cookie;
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('POST /api/invites (AUTH-04)', () => {
  it('admin → 201 one-time link with the token in the #fragment; only its hash is stored; 72 h', async () => {
    const inv = await invite('New.Person@Example.test');
    expect(inv).toMatchObject({ email: 'new.person@example.test', role: 'member' });
    expect(inv.inviteUrl).toMatch(/^https:\/\/app\.example\.test\/invite#[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(invites).where(eq(invites.email, 'new.person@example.test'));
    expect(row!.tokenHash).toBe(sha256Hex(inv.token));
    expect(JSON.stringify(row)).not.toContain(inv.token);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(72 * 3600_000);
    const list = await app.inject({ method: 'GET', url: '/api/invites', headers: { cookie: adminCookie } });
    expect(list.json().map((i: { email: string }) => i.email)).toContain('new.person@example.test');
    expect(list.body).not.toContain(inv.token);
    expect(list.body).not.toContain(row!.tokenHash);
  });

  it('member → 403, anonymous → 401, existing user → 409, bad input → 400', async () => {
    expect((await post('/api/invites', { email: 'x@example.test' }, memberCookie)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/invites', headers: { cookie: memberCookie } })).statusCode).toBe(403);
    expect((await post('/api/invites', { email: 'x@example.test' })).statusCode).toBe(401);
    const dup = await post('/api/invites', { email: 'MEMBER@example.test' }, adminCookie);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('conflict');
    for (const body of [{ email: 'no-at-sign' }, { email: 'a@b.c', role: 'owner' }, { email: 'a@b.c', expiresAt: '2099-01-01' }]) {
      expect((await post('/api/invites', body, adminCookie)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('accepting an invite (AUTH-05)', () => {
  it('TC-AUTH-05-1: check → accept sets name + password, signs in, creates the user with the invited role; second use → 410', async () => {
    const inv = await invite('bob@example.test');
    const check = await post('/api/invites/check', { token: inv.token });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ email: 'bob@example.test', role: 'member' });

    const acc = await post('/api/invites/accept', { token: inv.token, name: ' Bob ', password: 'bobs-long-password' });
    expect(acc.statusCode).toBe(201);
    expect(acc.json()).toEqual({ user: { id: expect.any(String), email: 'bob@example.test', name: 'Bob', role: 'member' } });
    const cookie = String(acc.headers['set-cookie']).split(';')[0]!;
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=43200']) expect(String(acc.headers['set-cookie'])).toContain(attr);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().email).toBe('bob@example.test');
    expect((await login('bob@example.test', 'bobs-long-password')).status).toBe(200);
    const [row] = await db.select().from(invites).where(eq(invites.tokenHash, sha256Hex(inv.token)));
    expect(row!.usedAt).not.toBeNull();
    expect(row!.usedBy).toBe(acc.json().user.id);

    const again = await post('/api/invites/accept', { token: inv.token, name: 'Mallory', password: 'mallorys-password' });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe('invite_used');
    expect((await post('/api/invites/check', { token: inv.token })).statusCode).toBe(410);
    expect((await db.select().from(users).where(eq(users.email, 'bob@example.test')))[0]!.name).toBe('Bob');
  });

  it('TC-AUTH-03: expired → 410 invite_expired; replaced by a newer invite → 404; unknown → 404', async () => {
    const old = await invite('carol@example.test');
    const fresh = await invite('carol@example.test'); // replaces the first
    expect((await post('/api/invites/check', { token: old.token })).statusCode).toBe(404);
    await db.update(invites).set({ createdAt: new Date(Date.now() - 73 * 3600_000), expiresAt: new Date(Date.now() - 3600_000) })
      .where(eq(invites.tokenHash, sha256Hex(fresh.token)));
    const exp = await post('/api/invites/accept', { token: fresh.token, name: 'Carol', password: 'carols-password-1' });
    expect(exp.statusCode).toBe(410);
    expect(exp.json().error).toBe('invite_expired');
    expect((await db.select().from(users).where(eq(users.email, 'carol@example.test')))).toHaveLength(0);
    const unknown = await post('/api/invites/check', { token: 'A'.repeat(43) });
    expect(unknown.statusCode).toBe(404);
  });

  it('two accepts at the same moment → exactly one user, the other gets 410', async () => {
    const inv = await invite('dave@example.test');
    const results = await Promise.all([1, 2, 3].map((i) =>
      post('/api/invites/accept', { token: inv.token, name: `Dave ${i}`, password: `daves-password-${i}x` })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 410, 410]);
    expect(await db.select().from(users).where(eq(users.email, 'dave@example.test'))).toHaveLength(1);
  });

  it('admin-role invite → admin user; weak password → 400 and the invite stays usable; invitee cannot pick a role', async () => {
    const inv = await invite('erin@example.test', 'admin');
    const weak = await post('/api/invites/accept', { token: inv.token, name: 'Erin', password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().message).toMatch(/at least 12/);
    const sneaky = await post('/api/invites/accept', { token: inv.token, name: 'Erin', password: 'erins-long-password', role: 'member' });
    expect(sneaky.statusCode).toBe(400); // unknown field refused
    const ok = await post('/api/invites/accept', { token: inv.token, name: 'Erin', password: 'erins-long-password' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user.role).toBe('admin');
  });

  it('a cross-origin page cannot accept an invite on the visitor’s behalf', async () => {
    const inv = await invite('frank@example.test');
    const res = await app.inject({ method: 'POST', url: '/api/invites/accept', headers: { origin: 'https://evil.example' },
      payload: { token: inv.token, name: 'F', password: 'franks-long-password' } });
    expect(res.statusCode).toBe(403);
    expect((await post('/api/invites/check', { token: inv.token })).statusCode).toBe(200);
  });
});
