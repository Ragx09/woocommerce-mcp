// Audit log writes (AUTH-11/13, docs/MCP_DESIGN.md §9). One row per tools/call and tools/list request
// and per refused /mcp request. Never arguments or results (privacy); error_code is a short machine code.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { auditLog, type AuditOutcome } from '../db/schema.js';

export type AuditSource = 'mcp' | 'chat';
export type AuditMethod = 'tools/call' | 'tools/list' | 'initialize' | 'other';

/** Who is calling, for this one request (AUTH-11). Built by /mcp auth and passed down explicitly. */
export interface CallContext {
  requestId: string;
  userId: string;
  keyId: string | null;
  source: AuditSource;
}

export interface AuditEvent {
  requestId: string;
  userId: string | null;
  apiKeyId: string | null;
  source: AuditSource;
  method: AuditMethod;
  upstreamId: string | null;
  upstreamSlug: string | null;
  tool: string | null;
  durationMs: number;
  outcome: AuditOutcome;
  errorCode: string | null;
}

export type AuditSink = (e: AuditEvent) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z_]{1,40}$/;

/**
 * Writes audit rows to Postgres. A failed write is logged (error level, no event details beyond ids)
 * and never turns a successful tool call into a failure for the client.
 */
export function dbAuditSink(db: Db, log: FastifyBaseLogger): AuditSink {
  return async (e) => {
    try {
      await db.insert(auditLog).values({
        requestId: UUID.test(e.requestId) ? e.requestId : null,
        userId: e.userId,
        apiKeyId: e.apiKeyId,
        source: e.source,
        method: e.method,
        upstreamId: e.upstreamId && UUID.test(e.upstreamId) ? e.upstreamId : null,
        upstreamSlug: e.upstreamSlug?.slice(0, 40) ?? null,
        tool: e.tool?.slice(0, 200) ?? null,
        durationMs: Math.max(0, Math.round(e.durationMs)),
        outcome: e.outcome,
        errorCode: e.errorCode && CODE.test(e.errorCode) ? e.errorCode : null,
      });
    } catch (err) {
      log.error({ err: (err as Error).message, requestId: e.requestId, outcome: e.outcome }, 'audit write failed');
    }
  };
}
