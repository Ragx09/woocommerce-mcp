// TC-UI-09-API (UI-09, REQ-AUTH-01/02): admin member management — list with key stats, disable/enable
// (effective on the next request for sessions and API keys), role changes, lock-out guards, invite
// withdrawal. Real Postgres.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { authenticateApiKey, createApiKey } from '../../src/auth/api-keys.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_users_${randomUUID().slice(0, 8)}`;
const ORIGIN = 'https://app.example.test';
const PW = 'users-api-password';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const login = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PW } });
  return r.statusCode === 200 ? String(r.headers['set-cookie']).split(';')[0]! : `status-${r.statusCode}`;
};
const req = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, cookie: string, payload?: object) =>
  app.inject({ method, url, headers: { origin: ORIGIN, cookie }, ...(payload ? { payload } : {}) });
const patch = (who: string, by: string, body: object) => req('PATCH', `/api/users/${ids[who]}`, cookies[by]!, body);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  await seedAdmin(db, { email: 'root@example.test', name: 'Root', password: PW });
  const hash = await hashPassword(PW);
  for (const [n, role] of [['ann', 'member'], ['ben', 'member']] as const) {
    await db.insert(users).values({ email: `${n}@example.test`, name: n, role, passwordHash: hash });
  }
  for (const r of await db.select().from(users)) ids[r.email.split('@')[0]!] = r.id;
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: ORIGIN });
  await app.ready();
  for (const n of ['root', 'ann']) cookies[n] = await login(`${n}@example.test`);
});
afterAll(async () => {
  await app?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('TC-UI-09-API members (UI-09)', () => {
  it('list: every user with role, status and active-key stats; never a password hash', async () => {
    await createApiKey(db, ids.ann!, 'laptop', ids.ann!);
    const k = await createApiKey(db, ids.ann!, 'old', ids.ann!);
    await req('DELETE', `/api/keys/${k.id}`, cookies.root!);
    const res = await req('GET', '/api/users', cookies.root!);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('argon2');
    const list = res.json() as Record<string, unknown>[];
    expect(list.map((u) => u.email)).toEqual(['root@example.test', 'ann@example.test', 'ben@example.test']);
    expect(list[1]).toMatchObject({ name: 'ann', role: 'member', disabledAt: null, activeKeys: 1, lastKeyUseAt: null });
    expect(list[2]).toMatchObject({ activeKeys: 0 });
    expect(Object.keys(list[0]!).sort()).toEqual(['activeKeys', 'createdAt', 'disabledAt', 'email', 'id', 'lastKeyUseAt', 'name', 'role']);
  });

  it('disable → session and API keys stop on the next request, login refused; enable → works again', async () => {
    const [key] = (await req('GET', '/api/keys', cookies.ann!)).json() as { id: string }[];
    expect(key).toBeDefined();
    const fresh = await createApiKey(db, ids.ann!, 'fresh', ids.ann!);
    expect(await authenticateApiKey(db, fresh.key)).not.toBeNull();
    const res = await patch('ann', 'root', { disabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().disabledAt).toEqual(expect.any(String));
    expect((await req('GET', '/api/me', cookies.ann!)).statusCode).toBe(401);
    expect(await authenticateApiKey(db, fresh.key)).toBeNull();
    expect(await login('ann@example.test')).toBe('status-401');
    expect((await patch('ann', 'root', { disabled: false })).json().disabledAt).toBeNull();
    expect(await authenticateApiKey(db, fresh.key)).not.toBeNull(); // keys were not revoked, only suspended
    cookies.ann = await login('ann@example.test');
    expect((await req('GET', '/api/me', cookies.ann)).statusCode).toBe(200);
  });

  it('lock-out guards: no self-demotion/disable, the last active admin stays admin', async () => {
    const self = await patch('root', 'root', { role: 'member' });
    expect([self.statusCode, self.json().message]).toEqual([409, 'you cannot disable or demote yourself']);
    expect((await patch('root', 'root', { disabled: true })).statusCode).toBe(409);
    expect((await patch('root', 'root', { role: 'admin' })).statusCode).toBe(200); // a no-op change is fine
    // Promote ben, then root may demote ben again; ben (admin) cannot demote root when root is the last other admin… both stay admins.
    expect((await patch('ben', 'root', { role: 'admin' })).json().role).toBe('admin');
    cookies.ben = await login('ben@example.test');
    expect((await req('GET', '/api/users', cookies.ben)).statusCode).toBe(200); // admin powers apply on the next request
    expect((await patch('ben', 'root', { role: 'member' })).json().role).toBe('member');
    expect((await req('GET', '/api/users', cookies.ben)).statusCode).toBe(403); // and are gone on the next request
  });

  it('two admins demoting each other at the same moment: exactly one succeeds', async () => {
    await patch('ben', 'root', { role: 'admin' });
    const [a, b] = await Promise.all([patch('root', 'ben', { role: 'member' }), patch('ben', 'root', { role: 'member' })]);
    // The loser gets 409 (last admin) or 403 (it is no longer an admin itself) depending on timing.
    expect([a.statusCode, b.statusCode].filter((s) => s === 200)).toHaveLength(1);
    expect([a.statusCode, b.statusCode].find((s) => s !== 200)).toBeOneOf([403, 409]);
    const admins = (await db.select().from(users)).filter((u) => u.role === 'admin' && !u.disabledAt);
    expect(admins).toHaveLength(1);
    // Restore root as an admin for the tests below.
    if (admins[0]!.email === 'ben@example.test') expect((await patch('root', 'ben', { role: 'admin' })).statusCode).toBe(200);
  });

  it('validation and errors: unknown user 404, empty body / unknown field / bad role 400', async () => {
    const adminCookie = cookies.root!;
    expect((await req('PATCH', `/api/users/${randomUUID()}`, adminCookie, { disabled: true })).statusCode).toBe(404);
    for (const body of [{}, { name: 'x' }, { role: 'owner' }]) {
      expect((await req('PATCH', `/api/users/${ids.ann}`, adminCookie, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('withdraw an open invite → its link is dead (404); used or unknown invite → 404', async () => {
    const inv = (await req('POST', '/api/invites', cookies.root!, { email: 'new@example.test' })).json();
    const token = inv.inviteUrl.split('#')[1];
    expect((await app.inject({ method: 'POST', url: '/api/invites/check', headers: { origin: ORIGIN }, payload: { token } })).statusCode).toBe(200);
    expect((await req('DELETE', `/api/invites/${inv.id}`, cookies.root!)).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/invites/check', headers: { origin: ORIGIN }, payload: { token } })).statusCode).toBe(404);
    expect((await req('GET', '/api/invites', cookies.root!)).json()).toEqual([]);
    expect((await req('DELETE', `/api/invites/${inv.id}`, cookies.root!)).statusCode).toBe(404);
  });
});
