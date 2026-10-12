import { loadConfig } from './config.js';
import { buildApp, VERSION } from './app.js';
import { loadCredentialKey } from './crypto/credentials.js';
import { createDb, createPool, loadDbConfig, pingDb, runMigrations } from './db/index.js';
import { loadWooSeed, seedUpstream } from './upstreams/seed.js';

const cfg = loadConfig();
const dbCfg = loadDbConfig();
const credentialKey = loadCredentialKey();
const wooSeed = loadWooSeed();
const pool = createPool(dbCfg);
const app = buildApp(cfg, { readinessChecks: [{ name: 'database', check: () => pingDb(pool) }] });

// An idle client erroring (e.g. Postgres restart) must not crash the process; the pool replaces it.
pool.on('error', (err) => app.log.warn({ err: err.message }, 'idle database client error'));

try {
  await runMigrations(pool, {
    connectTimeoutMs: dbCfg.connectTimeoutMs,
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
} catch (err) {
  // Exit non-zero: Kubernetes restarts us with back-off, and the reason is one readable log line.
  app.log.fatal({ err: (err as Error).message }, 'startup failed: database migrations');
  await pool.end().catch(() => {});
  process.exit(1);
}
app.log.info('database migrations applied');

if (wooSeed) {
  const result = await seedUpstream(createDb(pool), credentialKey, wooSeed);
  app.log.info({ slug: wooSeed.slug, result }, 'seed upstream');
}

await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ version: VERSION }, 'gateway listening');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(0), 5_000).unref();
    app.close().then(() => pool.end()).then(() => process.exit(0), () => process.exit(1));
  });
}
