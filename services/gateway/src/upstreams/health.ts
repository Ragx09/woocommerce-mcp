// GW-10: upstream health (docs/MCP_DESIGN.md §4a). Runtime state, kept in memory per replica.
// - A loop every 10 s reloads the registry from the DB and pings every enabled upstream in parallel
//   (allSettled, one deadline each), so a dead upstream is noticed even when nobody uses it and a
//   recovered one comes back without traffic.
// - Normal traffic also reports: a successful list/call marks Connected, a failure to connect marks
//   Unreachable at once. A slow tool call (timeout) says nothing about health and is not reported.
// - Unreachable upstreams are skipped by tools/list and fail fast on tools/call until a check succeeds
//   (docs/MCP_DESIGN.md §6), so one dead server cannot slow down every request.
// - Status values: connected | unreachable | disabled, plus unknown before the first check.
import type { Upstream } from '../db/schema.js';
import { safeReason, UpstreamTimeoutError, UpstreamUnavailableError, withDeadline, type UpstreamPool } from './pool.js';

export type HealthStatus = 'unknown' | 'connected' | 'unreachable' | 'disabled';

export interface UpstreamHealth {
  status: HealthStatus;
  /** Safe to show: no URLs, no credentials. Kept after recovery so the dashboard can show the last problem. */
  lastError: string | null;
  lastCheckedAt: Date | null;
  lastOkAt: Date | null;
}

export interface HealthOptions {
  loadUpstreams: () => Promise<Upstream[]>;
  /** Loop period (REQ: 10 s). */
  intervalMs?: number;
  /** Budget for one check, connect included (the list budget, 3 s). */
  checkTimeoutMs?: number;
  now?: () => Date;
  log?: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
}

const UNKNOWN: UpstreamHealth = { status: 'unknown', lastError: null, lastCheckedAt: null, lastOkAt: null };

/** The error text an upstream failure is recorded with. */
export function healthError(slug: string, e: unknown): string {
  if (e instanceof UpstreamUnavailableError || e instanceof UpstreamTimeoutError) return e.message;
  return `upstream ${slug} failed: ${safeReason(e)}`;
}

export class HealthMonitor {
  private readonly state = new Map<string, UpstreamHealth & { slug: string }>();
  private readonly intervalMs: number;
  private readonly checkTimeoutMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly pool: UpstreamPool, private readonly opts: HealthOptions) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? 3_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** First check right away, then every interval. Never throws; failures are logged. */
  start(): void {
    if (this.timer) return;
    void this.checkAll();
    this.timer = setInterval(() => { void this.checkAll(); }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One round over the registry. Overlapping rounds share the running one. */
  checkAll(): Promise<void> {
    this.running ??= this.round().finally(() => { this.running = undefined; });
    return this.running;
  }

  get(row: Upstream): UpstreamHealth {
    if (!row.enabled) return { ...(this.state.get(row.id) ?? UNKNOWN), status: 'disabled' };
    const s = this.state.get(row.id);
    if (!s) return { ...UNKNOWN };
    const { slug: _slug, ...health } = s;
    return health;
  }

  /** True only when the last signal said the upstream cannot be reached (unknown counts as usable). */
  isUnreachable(id: string): boolean {
    return this.state.get(id)?.status === 'unreachable';
  }

  /** Passive signal from normal traffic. */
  reportOk(row: Upstream): void {
    this.set(row, 'connected', null);
  }

  /** Passive signal: only connection failures and list timeouts mean "unreachable". */
  reportFailure(row: Upstream, e: unknown): void {
    this.set(row, 'unreachable', healthError(row.slug, e));
  }

  private async round(): Promise<void> {
    let rows: Upstream[];
    try {
      rows = await this.opts.loadUpstreams();
      await this.pool.sync(rows);
    } catch (e) {
      this.opts.log?.warn({ err: (e as Error).message }, 'health check: loading upstreams failed');
      return;
    }
    const ids = new Set(rows.map((r) => r.id));
    for (const id of this.state.keys()) if (!ids.has(id)) this.state.delete(id);
    for (const r of rows) if (!r.enabled) this.set(r, 'disabled', this.state.get(r.id)?.lastError ?? null, false);

    await Promise.allSettled(rows.filter((r) => r.enabled).map(async (r) => {
      try {
        await withDeadline(r.slug, this.checkTimeoutMs, (signal) =>
          this.pool.withClient(r.id, (c) => c.ping({ signal, timeout: this.checkTimeoutMs })));
        this.reportOk(r);
      } catch (e) {
        this.reportFailure(r, e);
      }
    }));
  }

  private set(row: Upstream, status: HealthStatus, lastError: string | null, checked = true): void {
    const prev = this.state.get(row.id);
    const at = this.now();
    this.state.set(row.id, {
      slug: row.slug,
      status,
      lastError: status === 'connected' ? (prev?.lastError ?? null) : lastError,
      lastCheckedAt: checked ? at : (prev?.lastCheckedAt ?? null),
      lastOkAt: status === 'connected' ? at : (prev?.lastOkAt ?? null),
    });
    if (prev?.status !== status) {
      const entry = { upstream: row.slug, from: prev?.status ?? 'unknown', to: status, ...(lastError ? { err: lastError } : {}) };
      if (status === 'unreachable') this.opts.log?.warn(entry, 'upstream status changed');
      else this.opts.log?.info(entry, 'upstream status changed');
    }
  }
}
