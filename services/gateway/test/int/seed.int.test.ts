// GW-03 against a real Postgres (scripts/gateway-db-int.sh).
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { upstreams } from '../../src/db/schema.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { seedUpstream, type SeedUpstream } from '../../src/upstreams/seed.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_seed_${randomUUID().slice(0, 8)}`;
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const woo = (token = 'token-v1'): SeedUpstream => ({
  slug: 'woo', name: 'WooCommerce', url: 'http://woo-mcp.store.svc.cluster.local/mcp', authType: 'bearer', credential: token,
});
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

const wooRow = async () => (await db.select().from(upstreams).where(eq(upstreams.slug, 'woo')))[0];
const reset = async () => { await pool.query('TRUNCATE upstreams, app_meta'); };

describe('seed woo upstream (GW-03)', () => {
  it('TC-GW-03-1: fresh DB → woo created, listed first, credential encrypted and decryptable', async () => {
    await reset();
    expect(await seedUpstream(db, key, woo())).toBe('created');
    await db.insert(upstreams).values({ slug: 'later', name: 'Later', url: 'http://later/mcp' });
    const list = await listUpstreams(db);
    expect(list.map((u) => u.slug)).toEqual(['woo', 'later']);
    const row = (await wooRow())!;
    expect(row).toMatchObject({ authType: 'bearer', enabled: true, createdBy: null });
    expect(JSON.stringify(row.credentialEnc)).not.toContain('token-v1');
    expect(decryptCredential(key, 'woo', row.credentialEnc!)).toBe('token-v1');
  });

  it('TC-GW-03-2: restart with the same values → unchanged (row not rewritten)', async () => {
    const before = (await wooRow())!.updatedAt.getTime();
    expect(await seedUpstream(db, key, woo())).toBe('unchanged');
    expect((await wooRow())!.updatedAt.getTime()).toBe(before);
  });

  it('TC-GW-03-3: untouched row + rotated token → refreshed', async () => {
    expect(await seedUpstream(db, key, woo('token-v2'))).toBe('refreshed');
    expect(decryptCredential(key, 'woo', (await wooRow())!.credentialEnc!)).toBe('token-v2');
    expect(await seedUpstream(db, key, woo('token-v2'))).toBe('unchanged');
  });

  it('TC-GW-03-4: admin edit → never overwritten, even when values change later', async () => {
    await db.update(upstreams).set({ name: 'Our Shop', enabled: false }).where(eq(upstreams.slug, 'woo'));
    expect(await seedUpstream(db, key, woo('token-v3'))).toBe('admin-edited');
    const row = (await wooRow())!;
    expect(row).toMatchObject({ name: 'Our Shop', enabled: false });
    expect(decryptCredential(key, 'woo', row.credentialEnc!)).toBe('token-v2');
  });

  it('TC-GW-03-5: admin deleted it → not re-created', async () => {
    await db.delete(upstreams).where(eq(upstreams.slug, 'woo'));
    expect(await seedUpstream(db, key, woo())).toBe('admin-deleted');
    expect(await wooRow()).toBeUndefined();
  });

  it('TC-GW-03-6: slug already created by hand before the first seed → left alone', async () => {
    await reset();
    await db.insert(upstreams).values({ slug: 'woo', name: 'Manual', url: 'http://manual/mcp' });
    expect(await seedUpstream(db, key, woo())).toBe('admin-edited');
    expect(await seedUpstream(db, key, woo('other'))).toBe('admin-edited');
    expect((await wooRow())!).toMatchObject({ name: 'Manual', url: 'http://manual/mcp', credentialEnc: null });
  });

  it('TC-GW-03-7: replicas seeding at the same time → exactly one row', async () => {
    await reset();
    const results = await Promise.all([1, 2, 3, 4].map(() => seedUpstream(db, key, woo())));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'unchanged')).toHaveLength(3);
    expect(await db.select().from(upstreams)).toHaveLength(1);
  });
});
