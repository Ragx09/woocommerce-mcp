// `npm run db:migrate -w services/gateway`: apply migrations and exit (the server also does this at startup).
import { createPool, loadDbConfig, runMigrations } from './db/index.js';

const cfg = loadDbConfig();
const pool = createPool(cfg);
try {
  await runMigrations(pool, { connectTimeoutMs: cfg.connectTimeoutMs, log: (m, x) => console.error(m, x ?? '') });
  console.log('migrations applied');
} finally {
  await pool.end();
}
