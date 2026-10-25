// Provisioner (D-026): the only component with Kubernetes rights. Single replica; a Postgres advisory lock on a
// dedicated connection makes sure that even two pods (e.g. during a rollout) never reconcile at once — the lock
// dies with the connection, so a killed pod frees it immediately.
import { createServer } from 'node:http';
import pg from 'pg';
import pino from 'pino';
import { fetch } from 'undici';
import { helmCli } from './helm.js';
import { inClusterKube } from './kube.js';
import { Reconciler, type Gateway, type StoreRow } from './reconcile.js';
import { SIGNATURE_HEADER, sign } from './signing.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { svc: 'provisioner' } });
const need = (n: string) => { const v = process.env[n]?.trim(); if (!v) throw new Error(`missing required environment variable ${n}`); return v; };
const key = Buffer.from(need('PROVISIONER_SIGNING_KEY'), 'hex');
if (key.length !== 32) throw new Error('PROVISIONER_SIGNING_KEY must be 64 hex characters');
const gatewayUrl = need('GATEWAY_INTERNAL_URL').replace(/\/+$/, '');
const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? 5_000);
const LOCK_ID = '7400183299';

const pool = new pg.Pool({ host: need('PGHOST'), port: Number(process.env.PGPORT ?? 5432), user: process.env.PGUSER ?? 'provisioner',
  password: need('PGPASSWORD'), database: process.env.PGDATABASE ?? 'gateway', max: 3, statement_timeout: 10_000, connectionTimeoutMillis: 5_000 });
pool.on('error', (err) => log.warn({ err: err.message }, 'idle database client error'));

async function post(path: string, body: object): Promise<void> {
  const raw = JSON.stringify(body);
  const res = await fetch(`${gatewayUrl}${path}`, { method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(key, 'POST', path, raw) }, body: raw });
  if (!res.ok) throw new Error(`gateway ${path.replace(/[0-9a-f-]{36}/, ':id')}: ${res.status}`);
}
const gateway: Gateway = {
  ready: (id, b) => post(`/internal/stores/${id}/ready`, b),
  failed: (id, reason) => post(`/internal/stores/${id}/failed`, { reason }),
  deleted: (id) => post(`/internal/stores/${id}/deleted`, {}),
};

const reconciler = new Reconciler({
  kube: inClusterKube(), helm: helmCli({ chart: process.env.STORE_CHART ?? '/charts/store' }), gateway, log,
  baseValues: JSON.parse(need('STORE_BASE_VALUES')) as Record<string, unknown>,
  timeoutMs: Number(process.env.PROVISION_TIMEOUT_MS ?? 15 * 60_000),
  serviceAccount: { name: process.env.SERVICE_ACCOUNT ?? 'provisioner', namespace: need('POD_NAMESPACE') },
});

let leader: pg.PoolClient | null = null;
let lastPassOk = 0;

async function loadRows(): Promise<StoreRow[]> {
  const { rows } = await pool.query<{ id: string; slug: string; name: string; tagline: string; niche: string; niche_text: string | null; status: StoreRow['status']; desired: StoreRow['desired']; created_at: Date }>(
    `SELECT id, slug, name, tagline, niche, niche_text, status, desired, created_at FROM stores
      WHERE (desired = 'present' AND status = 'provisioning') OR (desired = 'absent' AND status = 'deleting') ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, tagline: r.tagline, niche: r.niche, nicheText: r.niche_text, status: r.status, desired: r.desired, createdAt: r.created_at }));
}

async function tick(): Promise<void> {
  try {
    if (!leader) {
      const c = await pool.connect();
      const { rows } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
      if (!rows[0]?.ok) { c.release(); return; }
      c.on('error', () => { leader = null; });
      leader = c;
      log.info('reconcile lock acquired');
    }
    // Stores are processed in the background; the next tick picks up whatever is still pending.
    const rows = await loadRows();
    void reconciler.pass(rows, Number(process.env.MAX_CONCURRENT ?? 3));
    lastPassOk = Date.now();
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'reconcile tick failed');
    if (leader) { leader.release(true); leader = null; }
  }
}

// Probes: alive = process up; ready = a pass succeeded recently (DB reachable).
createServer((req, res) => {
  const ok = req.url === '/healthz' || (req.url === '/readyz' && Date.now() - lastPassOk < 6 * intervalMs);
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'not_ready' }));
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');

const timer = setInterval(() => void tick(), intervalMs);
void tick();
log.info({ intervalMs, gatewayUrl }, 'provisioner started');
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { clearInterval(timer); leader?.release(); void pool.end().finally(() => process.exit(0)); });
}
