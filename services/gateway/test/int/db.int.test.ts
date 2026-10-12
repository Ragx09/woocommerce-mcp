// Needs a throwaway Postgres: scripts/gateway-db-int.sh starts one and sets PG* variables.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, loadDbConfig, pingDb, runMigrations } from '../../src/db/index.js';
import { upstreams } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_test_${randomUUID().slice(0, 8)}`;
let pool: pg.Pool;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`); // fresh, empty database per run
  pool = createPool({ ...base, database: dbName });
});
afterAll(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const applied = async () =>
  Number((await pool.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count);

describe('migrations', () => {
  it('TC-GW-02-1: applies on a fresh DB; a second run is a no-op', async () => {
    await runMigrations(pool);
    const first = await applied();
    expect(first).toBeGreaterThan(0);
    await runMigrations(pool);
    expect(await applied()).toBe(first);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'upstreams' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'id', 'slug', 'name', 'url', 'enabled', 'auth_type', 'auth_header', 'credential_enc', 'created_by', 'created_at', 'updated_at',
    ]);
  });

  it('TC-GW-02-2: concurrent runs (replicas starting together) do not fail or double-apply', async () => {
    const before = await applied();
    await Promise.all([runMigrations(pool), runMigrations(pool), runMigrations(pool)]);
    expect(await applied()).toBe(before);
  });

  it('TC-GW-02-3: gives up with a clear error when the database is unreachable', async () => {
    const dead = createPool({ ...base, host: '127.0.0.1', port: 1 });
    await expect(runMigrations(dead, { connectTimeoutMs: 1_500 })).rejects.toThrow(/database not reachable/);
    await dead.end();
  });

  it('readiness ping works', async () => {
    expect(await pingDb(pool)).toBe(true);
  });
});

describe('upstreams constraints', () => {
  const ok = { slug: 'woo', name: 'WooCommerce', url: 'http://woo-mcp.store.svc.cluster.local/mcp' };

  it('TC-GW-02-4: valid rows insert with defaults', async () => {
    const db = createDb(pool);
    const [row] = await db.insert(upstreams).values({ ...ok, authType: 'header', authHeader: 'X-Internal-Token' }).returning();
    expect(row).toMatchObject({ slug: 'woo', enabled: true, authType: 'header', credentialEnc: null });
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['duplicate slug', { ...ok }, 'upstreams_slug_unique'],
    ['slug with underscore (would break slug__tool routing)', { ...ok, slug: 'my_srv' }, 'upstreams_slug_format'],
    ['slug too long', { ...ok, slug: 'a'.repeat(21) }, 'upstreams_slug_format'],
    ['uppercase slug', { ...ok, slug: 'Woo2' }, 'upstreams_slug_format'],
    ['non-http url', { ...ok, slug: 'x1', url: 'file:///etc/passwd' }, 'upstreams_url_http'],
    ['empty name', { ...ok, slug: 'x2', name: '' }, 'upstreams_name_length'],
    ['header auth without header name', { ...ok, slug: 'x3', authType: 'header' as const }, 'upstreams_auth_header'],
    ['header name on bearer auth', { ...ok, slug: 'x4', authType: 'bearer' as const, authHeader: 'X-A' }, 'upstreams_auth_header'],
    ['header name with injection chars', { ...ok, slug: 'x5', authType: 'header' as const, authHeader: 'X-A\r\nEvil: 1' }, 'upstreams_auth_header'],
    ['credential with auth none', { ...ok, slug: 'x6', credentialEnc: { v: 1 as const, iv: 'a', ciphertext: 'b', tag: 'c' } }, 'upstreams_credential'],
    ['unknown auth type', { ...ok, slug: 'x7', authType: 'oauth' as never }, 'upstreams_auth_type'],
  ])('TC-GW-02-5: rejects %s', async (_label, row, constraint) => {
    const err = await createDb(pool).insert(upstreams).values(row).then(() => null, (e: Error) => e);
    expect(err, 'insert should fail').not.toBeNull();
    const pgErr = (err!.cause ?? err) as { constraint?: string };
    expect(pgErr.constraint).toBe(constraint);
  });
});
