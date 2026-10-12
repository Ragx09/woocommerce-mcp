// Postgres pool + migrations. Migrations run at startup under an advisory lock, so several gateway
// replicas starting at once apply each migration exactly once (the others wait, then see nothing to do).
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** How long startup keeps retrying while Postgres is not reachable yet. */
  connectTimeoutMs: number;
}

/** Reads the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE). */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const need = (n: string) => {
    const v = env[n]?.trim();
    if (!v) throw new Error(`missing required environment variable ${n}`);
    return v;
  };
  const port = Number(env.PGPORT ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PGPORT must be a port number');
  return {
    host: need('PGHOST'),
    port,
    user: env.PGUSER?.trim() || 'gateway',
    password: need('PGPASSWORD'),
    database: env.PGDATABASE?.trim() || 'gateway',
    connectTimeoutMs: Number(env.DB_CONNECT_TIMEOUT_MS ?? 60_000),
  };
}

export function createPool(cfg: DbConfig): pg.Pool {
  return new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000, // no query may hold a connection forever
  });
}

export const createDb = (pool: pg.Pool): Db => drizzle(pool, { schema });

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));
/** Arbitrary constant shared by all replicas: "gateway migrations" lock id. */
const MIGRATION_LOCK_ID = 7_400_183_210n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for Postgres (bounded), then applies pending migrations under the advisory lock. */
export async function runMigrations(
  pool: pg.Pool,
  opts: { connectTimeoutMs?: number; log?: (msg: string, extra?: object) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  const deadline = Date.now() + (opts.connectTimeoutMs ?? 60_000);
  let client: pg.PoolClient | undefined;
  for (let attempt = 1; !client; attempt++) {
    try {
      client = await pool.connect();
    } catch (e) {
      if (Date.now() >= deadline) throw new Error(`database not reachable: ${(e as Error).message}`);
      log('database not reachable yet, retrying', { attempt, err: (e as Error).message });
      await sleep(Math.min(1_000 * attempt, 5_000));
    }
  }
  try {
    // Session-level lock on this one connection; held for the whole migration run.
    await client.query({ text: 'SELECT pg_advisory_lock($1)', values: [MIGRATION_LOCK_ID.toString()] });
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await client.query({ text: 'SELECT pg_advisory_unlock($1)', values: [MIGRATION_LOCK_ID.toString()] });
    }
  } finally {
    client.release();
  }
}

/** Readiness: a cheap round trip. */
export async function pingDb(pool: pg.Pool): Promise<boolean> {
  await pool.query('SELECT 1');
  return true;
}
