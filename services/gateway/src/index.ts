import { loadConfig } from './config.js';
import { buildApp, VERSION } from './app.js';
import { loadCredentialKey } from './crypto/credentials.js';
import { createDb, createPool, loadDbConfig, pingDb, runMigrations } from './db/index.js';
import { registerMcp } from './mcp/route.js';
import { ToolDiscovery } from './upstreams/discovery.js';
import { HealthMonitor } from './upstreams/health.js';
import { UpstreamPool } from './upstreams/pool.js';
import { listUpstreams } from './upstreams/repo.js';
import { loadSeeds, seedUpstream } from './upstreams/seed.js';
import { authenticateApiKey } from './auth/api-keys.js';
import { registerAuth } from './auth/routes.js';
import { loadAdminSeed, seedAdmin } from './auth/seed-admin.js';

const cfg = loadConfig();
const dbCfg = loadDbConfig();
const credentialKey = loadCredentialKey();
const seedPlan = loadSeeds();
const adminSeed = loadAdminSeed();
const dbPool = createPool(dbCfg);
const app = buildApp(cfg, { readinessChecks: [{ name: 'database', check: () => pingDb(dbPool) }] });

// An idle client erroring (e.g. Postgres restart) must not crash the process; the pool replaces it.
dbPool.on('error', (err) => app.log.warn({ err: err.message }, 'idle database client error'));

try {
  await runMigrations(dbPool, {
    connectTimeoutMs: dbCfg.connectTimeoutMs,
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
} catch (err) {
  // Exit non-zero: Kubernetes restarts us with back-off, and the reason is one readable log line.
  app.log.fatal({ err: (err as Error).message }, 'startup failed: database migrations');
  await dbPool.end().catch(() => {});
  process.exit(1);
}
app.log.info('database migrations applied');

for (const seed of seedPlan.seeds) {
  const result = await seedUpstream(createDb(dbPool), credentialKey, seed);
  app.log.info({ slug: seed.slug, result }, 'seed upstream');
}
for (const s of seedPlan.skipped) app.log.warn(s, 'seed upstream skipped');
if (adminSeed) app.log.info({ result: await seedAdmin(createDb(dbPool), adminSeed) }, 'seed admin');
else app.log.warn('ADMIN_EMAIL not set: no admin is seeded');

// Upstream MCP clients (GW-04). Connections open lazily on first use.
const upstreamPool = new UpstreamPool({ key: credentialKey, connectTimeoutMs: cfg.upstreamTimeouts.connectMs, log: app.log });
await upstreamPool.sync(await listUpstreams(createDb(dbPool)));
app.log.info({ upstreams: upstreamPool.upstreams().map((u) => u.slug), timeouts: cfg.upstreamTimeouts }, 'upstream pool ready');

// Gateway MCP endpoint (GW-06). Upstreams are reloaded from the DB on each tools/list.
const db = createDb(dbPool);
// Upstream health (GW-10): checked every interval, also fed by normal traffic.
const health = new HealthMonitor(upstreamPool, {
  loadUpstreams: () => listUpstreams(db),
  intervalMs: cfg.healthIntervalMs,
  checkTimeoutMs: cfg.upstreamTimeouts.listMs,
  log: app.log,
});
await registerAuth(app, { db, cookieSecure: cfg.cookieSecure, publicOrigin: cfg.publicOrigin });
if (!cfg.publicOrigin) app.log.warn('PUBLIC_ORIGIN not set: browser POST/PATCH/DELETE on /api are refused');
registerMcp(app, {
  authenticate: (token) => authenticateApiKey(db, token),
  loadUpstreams: () => listUpstreams(db),
  pool: upstreamPool,
  discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: cfg.upstreamTimeouts.listMs, log: app.log, health }),
  health,
  callTimeoutMs: cfg.upstreamTimeouts.callMs,
});

await app.listen({ port: cfg.port, host: cfg.host });
health.start();
app.log.info({ version: VERSION }, 'gateway listening');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(0), 5_000).unref();
    app.close().then(() => health.stop()).then(() => upstreamPool.close()).then(() => dbPool.end()).then(() => process.exit(0), () => process.exit(1));
  });
}
