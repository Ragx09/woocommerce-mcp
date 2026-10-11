import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createHttpServer, VERSION } from './server.js';

const cfg = loadConfig();
const log = pino({
  level: cfg.logLevel,
  base: { svc: 'woo-mcp' },
  redact: { paths: ['req.headers.authorization', '*.authorization', '*.consumer_secret', '*.oauth_signature'], censor: '[redacted]' },
});

const server = createHttpServer(cfg, log);
server.listen(cfg.port, () => {
  log.info({ port: cfg.port, version: VERSION, store: cfg.wooBaseUrl, auth: cfg.mcpAuthToken ? 'bearer' : 'disabled' }, 'woo-mcp listening');
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
