import { loadConfig } from './config.js';
import { buildApp, VERSION } from './app.js';
import { loadCredentialKey } from './crypto/credentials.js';
import { createDb, createPool, loadDbConfig, pingDb, runMigrations } from './db/index.js';
import { registerMcp } from './mcp/route.js';
import { ToolDiscovery } from './upstreams/discovery.js';
import { UpstreamPool } from './upstreams/pool.js';
import { listUpstreams } from './upstreams/repo.js';
import { loadWooSeed, seedUpstream } from './upstreams/seed.js';

const cfg = loadConfig();
const dbCfg = loadDbConfig();
const credentialKey = loadCredentialKey();
const wooSeed = loadWooSeed();
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

if (wooSeed) {
  const result = await seedUpstream(createDb(dbPool), credentialKey, wooSeed);
  app.log.info({ slug: wooSeed.slug, result }, 'seed upstream');
}

// Upstream MCP clients (GW-04). Connections open lazily on first use.
const upstreamPool = new UpstreamPool({ key: credentialKey, log: app.log });
await upstreamPool.sync(await listUpstreams(createDb(dbPool)));
app.log.info({ upstreams: upstreamPool.upstreams().map((u) => u.slug) }, 'upstream pool ready');

// Gateway MCP endpoint (GW-06). Upstreams are reloaded from the DB on each tools/list.
const db = createDb(dbPool);
registerMcp(app, {
  devKey: cfg.mcpDevKey,
  loadUpstreams: () => listUpstreams(db),
  pool: upstreamPool,
  discovery: new ToolDiscovery(upstreamPool, { log: app.log }),
});
if (!cfg.mcpDevKey) app.log.warn('MCP_DEV_KEY not set: /mcp refuses all requests');

await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ version: VERSION }, 'gateway listening');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(0), 5_000).unref();
    app.close().then(() => upstreamPool.close()).then(() => dbPool.end()).then(() => process.exit(0), () => process.exit(1));
  });
}
