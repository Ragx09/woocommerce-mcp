// TC-AUTH-01-1 (AUTH-01): users, sessions, invites, api_keys and audit_log exist after migrating a fresh
// database, and the database itself refuses rows that would break the security model.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, loadDbConfig, runMigrations } from '../../src/db/index.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_auth_${randomUUID().slice(0, 8)}`;
let pool: pg.Pool;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
});
afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const ARGON = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
const columns = async (table: string) => (await pool.query(
  'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [table])).rows.map((r) => r.column_name);
/** The constraint a failing statement violated (name), or 'ok'. */
const violates = async (text: string, values: unknown[] = []) =>
  pool.query(text, values).then(() => 'ok', (e: { constraint?: string; code?: string }) => e.constraint ?? e.code);
async function user(email: string, role = 'member'): Promise<string> {
  return (await pool.query('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, 'Test', role, ARGON])).rows[0].id;
}

describe('TC-AUTH-01-1 auth and audit schema (AUTH-01)', () => {
  it('fresh migrate → the five tables with the expected columns and indexes', async () => {
    expect(await columns('users')).toEqual(['id', 'email', 'name', 'role', 'password_hash', 'disabled_at', 'created_at', 'updated_at']);
    expect(await columns('sessions')).toEqual(['id_hash', 'user_id', 'created_at', 'expires_at', 'last_seen_at']);
    expect(await columns('invites')).toEqual(['id', 'token_hash', 'email', 'role', 'created_by', 'created_at', 'expires_at', 'used_at', 'used_by']);
    expect(await columns('api_keys')).toEqual(['id', 'user_id', 'name', 'key_hash', 'prefix', 'created_by', 'created_at', 'last_used_at', 'revoked_at', 'revoked_by']);
    expect(await columns('audit_log')).toEqual(['id', 'ts', 'request_id', 'user_id', 'api_key_id', 'source', 'method', 'upstream_id',
      'upstream_slug', 'tool', 'duration_ms', 'outcome', 'error_code']);
    const idx = (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('audit_log', 'api_keys', 'sessions')`)).rows.map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['audit_ts_idx', 'audit_user_ts_idx', 'audit_upstream_ts_idx',
      'api_keys_key_hash_unique', 'api_keys_user_idx', 'sessions_user_idx', 'sessions_expires_idx']));
  });

  it('users: email lower-case and unique, role admin|member, only argon2id hashes', async () => {
    await user('a@example.test', 'admin');
    expect(await violates(`INSERT INTO users (email, name, password_hash) VALUES ('A@example.test', 'x', $1)`, [ARGON])).toBe('users_email_format');
    expect(await violates(`INSERT INTO users (email, name, password_hash) VALUES ('a@example.test', 'x', $1)`, [ARGON])).toBe('users_email_unique');
    expect(await violates(`INSERT INTO users (email, name, password_hash) VALUES ('no at sign', 'x', $1)`, [ARGON])).toBe('users_email_format');
    expect(await violates(`INSERT INTO users (email, name, role, password_hash) VALUES ('b@example.test', 'x', 'owner', $1)`, [ARGON])).toBe('users_role');
    expect(await violates(`INSERT INTO users (email, name, password_hash) VALUES ('c@example.test', 'x', 'hunter2')`)).toBe('users_password_hash');
    expect((await pool.query(`SELECT role FROM users WHERE email = 'a@example.test'`)).rows[0].role).toBe('admin');
  });

  it('api_keys: only a SHA-256 hash and a 12-char prefix are accepted, never the key itself', async () => {
    const uid = await user('keys@example.test');
    const key = `mgw_${'Ab3'.repeat(14)}`;
    const ins = (hash: string, prefix: string) =>
      violates('INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4)', [uid, 'laptop', hash, prefix]);
    expect(await ins(h(key), key.slice(0, 12))).toBe('ok');
    expect(await ins(key, key.slice(0, 12))).toBe('api_keys_key_hash'); // plaintext in the hash column
    expect(await ins(h(`${key}2`), key)).toBe('api_keys_prefix'); // whole key as "prefix"
    expect(await ins(h(key), key.slice(0, 12))).toBe('api_keys_key_hash_unique');
  });

  it('sessions and invites: hashed tokens, expiry after creation; deleting a user removes its sessions and keys', async () => {
    const uid = await user('s@example.test');
    expect(await violates(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '12 hours')`, [h('tok'), uid])).toBe('ok');
    expect(await violates(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('raw-token', $1, now() + interval '1 hour')`, [uid])).toBe('sessions_id_hash');
    expect(await violates(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 hour')`, [h('t2'), uid])).toBe('sessions_expiry');
    expect(await violates(`INSERT INTO invites (token_hash, email, expires_at) VALUES ($1, 'm@example.test', now() + interval '72 hours')`, [h('inv')])).toBe('ok');
    expect(await violates(`INSERT INTO invites (token_hash, email, expires_at) VALUES ('raw', 'm@example.test', now() + interval '1 hour')`)).toBe('invites_token_hash');
    expect(await violates(`INSERT INTO invites (token_hash, email, role, expires_at) VALUES ($1, 'm@example.test', 'root', now() + interval '1 hour')`, [h('i2')])).toBe('invites_role');
    expect(await violates(`INSERT INTO invites (token_hash, email, expires_at, used_by) VALUES ($1, 'm@example.test', now() + interval '1 hour', $2)`, [h('i3'), uid])).toBe('invites_used');
    await pool.query('INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4)', [uid, 'k', h('s-key'), 'mgw_abcdefgh']);
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [uid])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1', [uid])).rows[0].n).toBe(0);
  });

  it('audit_log: known sources/outcomes only, denied rows carry no user, rows outlive users and keys', async () => {
    const uid = await user('audit@example.test');
    const kid = (await pool.query('INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES ($1, $2, $3, $4) RETURNING id',
      [uid, 'k', h('audit-key'), 'mgw_audit123'])).rows[0].id;
    const row = (o: Record<string, unknown>) => {
      const r = { source: 'mcp', method: 'tools/call', duration_ms: 12, outcome: 'ok', user_id: uid, api_key_id: kid,
        upstream_slug: 'woo', tool: 'list_orders', error_code: null, request_id: randomUUID(), ...o };
      return violates(`INSERT INTO audit_log (source, method, duration_ms, outcome, user_id, api_key_id, upstream_slug, tool, error_code, request_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.source, r.method, r.duration_ms, r.outcome, r.user_id, r.api_key_id, r.upstream_slug, r.tool, r.error_code, r.request_id]);
    };
    for (const outcome of ['ok', 'tool_error', 'error', 'timeout', 'unreachable', 'rejected']) expect(await row({ outcome }), outcome).toBe('ok');
    expect(await row({ outcome: 'denied', user_id: null, api_key_id: null, error_code: 'invalid_api_key', upstream_slug: null, tool: null })).toBe('ok');
    expect(await row({ outcome: 'denied' })).toBe('audit_denied_user');
    expect(await row({ outcome: 'maybe' })).toBe('audit_outcome');
    expect(await row({ source: 'cron' })).toBe('audit_source');
    expect(await row({ duration_ms: -1 })).toBe('audit_duration');
    expect(await row({ error_code: 'upstream said: token=abc' })).toBe('audit_error_code'); // codes only, no free text
    expect(await row({ method: 'tools/list', tool: null, source: 'chat' })).toBe('ok');
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
    const left = (await pool.query(`SELECT count(*)::int AS n, count(user_id)::int AS u FROM audit_log WHERE upstream_slug = 'woo'`)).rows[0];
    expect(left.n).toBeGreaterThanOrEqual(6); // history kept…
    expect(left.u).toBe(0); // …with the link to the deleted user cleared
  });

  it('upstreams.created_by now references users (set null when the user goes)', async () => {
    const uid = await user('creator@example.test', 'admin');
    await pool.query(`INSERT INTO upstreams (slug, name, url, created_by) VALUES ('mine', 'Mine', 'http://mine/mcp', $1)`, [uid]);
    expect(await violates(`INSERT INTO upstreams (slug, name, url, created_by) VALUES ('ghost', 'G', 'http://g/mcp', $1)`, [randomUUID()]))
      .toBe('upstreams_created_by_users_id_fk');
    await pool.query('DELETE FROM users WHERE id = $1', [uid]);
    expect((await pool.query(`SELECT created_by FROM upstreams WHERE slug = 'mine'`)).rows[0].created_by).toBeNull();
  });
});
