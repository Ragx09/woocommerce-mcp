// BON-03: per-server call statistics for the dashboard, from the audit log — so the numbers cover every
// gateway replica, unlike /metrics (one replica each). Last hour, tools/call only.
//   failed = the call did not produce a normal result: error, timeout, unreachable, or the tool's own isError;
//   rejected = refused by the gateway (unknown tool, disabled, not allowed) — counted apart from failures.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';

export interface CallStats { calls: number; failed: number; rejected: number; p95Ms: number | null }

export const STATS_WINDOW_MINUTES = 60;

export async function callStatsByUpstream(db: Db, windowMinutes = STATS_WINDOW_MINUTES): Promise<Map<string, CallStats>> {
  const res = await db.execute<{ upstream_id: string; calls: number; failed: number; rejected: number; p95: number | null }>(sql`
    SELECT upstream_id,
           count(*)::int AS calls,
           count(*) FILTER (WHERE outcome IN ('error', 'timeout', 'unreachable', 'tool_error'))::int AS failed,
           count(*) FILTER (WHERE outcome = 'rejected')::int AS rejected,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE outcome <> 'rejected') AS p95
      FROM audit_log
     WHERE method = 'tools/call' AND upstream_id IS NOT NULL
       AND ts > now() - make_interval(mins => ${windowMinutes})
     GROUP BY upstream_id`);
  return new Map(res.rows.map((r) => [r.upstream_id, {
    calls: Number(r.calls), failed: Number(r.failed), rejected: Number(r.rejected), p95Ms: r.p95 === null ? null : Number(r.p95),
  }]));
}
