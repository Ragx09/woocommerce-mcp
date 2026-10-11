import { loadConfig } from './config.js';
import { buildApp, VERSION } from './app.js';

const cfg = loadConfig();
const app = buildApp(cfg);

await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ version: VERSION }, 'gateway listening');

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(0), 5_000).unref();
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
