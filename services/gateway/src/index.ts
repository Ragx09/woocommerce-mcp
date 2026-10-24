import { loadConfig } from './config.js';
import { buildApp, VERSION } from './app.js';
import { loadCredentialKey } from './crypto/credentials.js';
import { createDb, createPool, loadDbConfig, pingDb, runMigrations } from './db/index.js';
import { registerMcp } from './mcp/route.js';
import { registerUpstreamRoutes } from './upstreams/routes.js';
import { ssrfPolicy } from './upstreams/ssrf.js';
import { ToolDiscovery } from './upstreams/discovery.js';
import { HealthMonitor } from './upstreams/health.js';
import { UpstreamPool } from './upstreams/pool.js';
import { listUpstreams } from './upstreams/repo.js';
import { loadSeeds, seedUpstream } from './upstreams/seed.js';
import { InternalTokenSigner, mcpAuthenticator } from './auth/internal-token.js';
import { openAiCompatible } from './chat/llm.js';
import { registerChatRoutes } from './chat/routes.js';
import { dbAuditSink } from './audit/audit.js';
import { registerAuth } from './auth/routes.js';
import { loadAdminSeed, seedAdmin } from './auth/seed-admin.js';
import { buildMetricsServer, Metrics } from './metrics.js';
import { PgRateLimiter } from './ratelimit.js';

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
// Chat agent LLM (UI-13): log where it points, never the key; without a key the chat is off.
if (cfg.llm.apiKey) app.log.info({ baseUrl: cfg.llm.baseUrl, model: cfg.llm.model }, 'chat llm configured');
else app.log.warn('LLM_API_KEY not set: the chat agent is disabled');

// SSRF guard (T-06): internal addresses only through allowlisted hosts — the operator's list plus the
// hosts of the upstreams the chart seeds (woo-mcp, everything-mcp).
const ssrf = ssrfPolicy([...cfg.upstreamAllowedHosts, ...seedPlan.seeds.map((s) => new URL(s.url).hostname)]);
app.log.info({ allowedHosts: [...ssrf.allowedHosts] }, 'ssrf allowlist');
// Upstream MCP clients (GW-04). Connections open lazily on first use.
const upstreamPool = new UpstreamPool({ key: credentialKey, connectTimeoutMs: cfg.upstreamTimeouts.connectMs, ssrf, log: app.log,
  maxResponseBytes: cfg.upstreamMaxResponseBytes });
await upstreamPool.sync(await listUpstreams(createDb(dbPool)));
app.log.info({ upstreams: upstreamPool.upstreams().map((u) => u.slug), timeouts: cfg.upstreamTimeouts, mcpRateLimit: cfg.mcpRateLimit }, 'upstream pool ready');

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
const discovery = new ToolDiscovery(upstreamPool, { listTimeoutMs: cfg.upstreamTimeouts.listMs, log: app.log, health });
registerUpstreamRoutes(app, { db, pool: upstreamPool, discovery, health, key: credentialKey, ssrf });
// UI-15: the chat agent's tokens; the key lives only in this process's memory.
const internalTokens = new InternalTokenSigner();
// BON-03: every audit event is also a metric observation (same events, counted once).
const metrics = new Metrics();
metrics.addGauge({ name: 'mcp_upstream_up', help: 'Upstream health as seen by this replica: 1 connected, 0 otherwise.',
  read: () => upstreamPool.upstreams().map((r) => {
    const status = health.get(r).status;
    return { labels: { upstream: r.slug, status }, value: status === 'connected' ? 1 : 0 };
  }) });
const auditToDb = dbAuditSink(db, app.log);
// BON-04: limits in Postgres, so every replica enforces the same budget.
const limiter = new PgRateLimiter(db);
registerMcp(app, {
  rateLimit: { limiter, ...cfg.mcpRateLimit },
  authenticate: mcpAuthenticator(db, internalTokens),
  audit: async (e) => { metrics.record(e); await auditToDb(e); },
  loadUpstreams: () => listUpstreams(db),
  pool: upstreamPool,
  discovery,
  health,
  callTimeoutMs: cfg.upstreamTimeouts.callMs,
});
// UI-14: dashboard chat agent → this process's own /mcp over loopback with the user's internal token.
registerChatRoutes(app, {
  llm: cfg.llm.apiKey ? openAiCompatible(cfg.llm) : null,
  limiter,
  signer: internalTokens,
  mcpUrl: () => `http://127.0.0.1:${cfg.port}/mcp`,
  unavailable: async () => (await listUpstreams(db)).filter((r) => r.enabled && health.isUnreachable(r.id))
    .map((r) => ({ server: r.slug, name: r.name })),
});

await app.listen({ port: cfg.port, host: cfg.host });
const metricsApp = cfg.metricsPort ? buildMetricsServer(metrics) : null;
if (metricsApp) await metricsApp.listen({ port: cfg.metricsPort, host: cfg.host });
health.start();
app.log.info({ version: VERSION, metricsPort: cfg.metricsPort || 'off' }, 'gateway listening');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(0), 5_000).unref();
    app.close().then(() => metricsApp?.close()).then(() => health.stop()).then(() => upstreamPool.close()).then(() => dbPool.end()).then(() => process.exit(0), () => process.exit(1));
  });
}
