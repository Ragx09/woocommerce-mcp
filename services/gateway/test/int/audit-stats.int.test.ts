// BON-03 (TC-BON-03-3): per-server call statistics for the dashboard from the audit log (all replicas):
// last hour only, failures vs gateway refusals, p95 latency without refusals. Real Postgres.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callStatsByUpstream } from '../../src/audit/stats.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { auditLog } from '../../src/db/schema.js';

const base = loadDbConfig();
const admin = createPool({ ...base, database: 'postgres' });
const dbName = `gw_stats_${randomUUID().slice(0, 8)}`;
let pool: pg.Pool;
let db: Db;
const WOO = randomUUID();
const EV = randomUUID();

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const row = (upstreamId: string | null, outcome: typeof auditLog.$inferInsert.outcome, durationMs: number, method = 'tools/call') =>
    ({ source: 'mcp' as const, method, upstreamId, upstreamSlug: upstreamId === WOO ? 'woo' : 'everything', durationMs, outcome });
  await db.insert(auditLog).values([
    ...Array.from({ length: 18 }, (_, i) => row(WOO, 'ok', 100 + i)), // 100..117 ms
    row(WOO, 'timeout', 15_000),
    row(WOO, 'tool_error', 90),
    row(WOO, 'rejected', 1), // not allowed / unknown: counted apart, not in the latency
    row(WOO, 'ok', 1, 'tools/list'), // lists are not calls
    row(null, 'rejected', 1), // unresolved upstream: not attributed to any server
    row(EV, 'unreachable', 5),
  ]);
  // An old row outside the window.
  await db.insert(auditLog).values({ ...row(EV, 'ok', 50), ts: sql`now() - interval '2 hours'` as unknown as Date });
});
afterAll(async () => {
  pool?.on('error', () => {});
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('TC-BON-03-3 call statistics per server (BON-03)', () => {
  it('counts calls, failures and refusals of the last hour; p95 without refusals and below the outlier', async () => {
    const stats = await callStatsByUpstream(db);
    // 20 non-refused woo calls sorted: 90, 100..117, 15000 → p95 = the 19th value = 117 (not the 15 s maximum).
    expect(stats.get(WOO)).toEqual({ calls: 21, failed: 2, rejected: 1, p95Ms: 117 });
    expect(stats.get(EV)).toEqual({ calls: 1, failed: 1, rejected: 0, p95Ms: 5 });
    expect(stats.size).toBe(2);
  });
});
