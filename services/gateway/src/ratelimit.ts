// BON-04 (REQ-SO-07): limits that hold across gateway replicas. Counters and leases live in Postgres, so
// two replicas behind Traefik share one budget per key/user instead of N× the budget.
//   hit():   fixed window per bucket, starting at the bucket's first hit (no clock-boundary resets);
//            one atomic upsert per request.
//   lease(): an exclusive hold that expires by itself (a pod that dies mid-request frees it after ttl).
// MemoryRateLimiter has the same semantics for one process (unit tests, tools without a database).
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './db/index.js';

export interface HitResult { allowed: boolean; hits: number; retryAfterS: number }
export type Release = () => Promise<void>;

export interface RateLimiter {
  /** Counts one hit on `bucket`; over `limit` in the current window → allowed=false with seconds to wait. */
  hit(bucket: string, limit: number, windowMs: number): Promise<HitResult>;
  /** Takes `key` for at most `ttlMs`, or null while someone else holds it. */
  lease(key: string, ttlMs: number): Promise<Release | null>;
}

const result = (hits: number, limit: number, remainingMs: number): HitResult =>
  ({ allowed: hits <= limit, hits, retryAfterS: hits <= limit ? 0 : Math.max(1, Math.ceil(remainingMs / 1000)) });

export class PgRateLimiter implements RateLimiter {
  constructor(private readonly db: Db) {}

  async hit(bucket: string, limit: number, windowMs: number): Promise<HitResult> {
    // In DO UPDATE every SET expression sees the old row, so both CASEs agree on "window over?".
    const res = await this.db.execute<{ hits: number; remaining_ms: number }>(sql`
      INSERT INTO rate_limits (bucket, window_start, hits) VALUES (${bucket}, now(), 1)
      ON CONFLICT (bucket) DO UPDATE SET
        window_start = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => ${windowMs / 1000}) THEN now() ELSE rate_limits.window_start END,
        hits = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => ${windowMs / 1000}) THEN 1 ELSE rate_limits.hits + 1 END
      RETURNING hits, (extract(epoch FROM window_start + make_interval(secs => ${windowMs / 1000}) - now()) * 1000)::float8 AS remaining_ms`);
    const row = res.rows[0]!;
    return result(Number(row.hits), limit, Number(row.remaining_ms));
  }

  async lease(key: string, ttlMs: number): Promise<Release | null> {
    const holder = randomUUID();
    const res = await this.db.execute(sql`
      INSERT INTO leases (key, holder, expires_at) VALUES (${key}, ${holder}, now() + make_interval(secs => ${ttlMs / 1000}))
      ON CONFLICT (key) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
        WHERE leases.expires_at < now()
      RETURNING holder`);
    if (res.rows.length === 0) return null;
    // Only our own hold: if it expired and someone else took the key, theirs stays.
    return async () => { await this.db.execute(sql`DELETE FROM leases WHERE key = ${key} AND holder = ${holder}`); };
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; hits: number }>();
  private readonly held = new Map<string, { holder: string; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async hit(bucket: string, limit: number, windowMs: number): Promise<HitResult> {
    const t = this.now();
    let w = this.windows.get(bucket);
    if (!w || w.start <= t - windowMs) { w = { start: t, hits: 0 }; this.windows.set(bucket, w); }
    w.hits++;
    if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (v.start <= t - windowMs) this.windows.delete(k);
    return result(w.hits, limit, w.start + windowMs - t);
  }

  async lease(key: string, ttlMs: number): Promise<Release | null> {
    const t = this.now();
    const cur = this.held.get(key);
    if (cur && cur.until > t) return null;
    const holder = randomUUID();
    this.held.set(key, { holder, until: t + ttlMs });
    return async () => { if (this.held.get(key)?.holder === holder) this.held.delete(key); };
  }
}
