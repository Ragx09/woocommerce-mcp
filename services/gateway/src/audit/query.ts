// GET /api/audit (AUTH-14): admin-only, filtered, newest first, keyset-paginated by id (stable while new
// rows arrive; no OFFSET scans). Returns display fields only: no key hashes, no arguments (none stored).
import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { apiKeys, AUDIT_OUTCOMES, AUDIT_SOURCES, auditLog, users, type AuditOutcome } from '../db/schema.js';

export interface AuditQuery {
  user?: string; upstream?: string; outcome?: AuditOutcome; source?: 'mcp' | 'chat';
  from?: string; to?: string; limit?: number; cursor?: string;
}

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    user: { type: 'string', format: 'uuid' },
    upstream: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
    outcome: { type: 'string', enum: [...AUDIT_OUTCOMES] },
    source: { type: 'string', enum: [...AUDIT_SOURCES] },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    cursor: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' },
  },
} as const;

export async function queryAudit(db: Db, q: AuditQuery) {
  const limit = q.limit ?? 50;
  const where: SQL[] = [];
  if (q.user) where.push(eq(auditLog.userId, q.user));
  if (q.upstream) where.push(eq(auditLog.upstreamSlug, q.upstream));
  if (q.outcome) where.push(eq(auditLog.outcome, q.outcome));
  if (q.source) where.push(eq(auditLog.source, q.source));
  if (q.from) where.push(gte(auditLog.ts, new Date(q.from)));
  if (q.to) where.push(lte(auditLog.ts, new Date(q.to)));
  if (q.cursor) where.push(lt(auditLog.id, Number(q.cursor)));
  const rows = await db.select({
    id: auditLog.id, ts: auditLog.ts, requestId: auditLog.requestId, source: auditLog.source, method: auditLog.method,
    upstream: auditLog.upstreamSlug, tool: auditLog.tool, durationMs: auditLog.durationMs, outcome: auditLog.outcome,
    errorCode: auditLog.errorCode, userId: users.id, userEmail: users.email, userName: users.name, keyPrefix: apiKeys.prefix,
  }).from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(apiKeys, eq(apiKeys.id, auditLog.apiKeyId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map(({ userId, userEmail, userName, ...r }) => ({
      ...r, user: userId ? { id: userId, email: userEmail, name: userName } : null,
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
  };
}

export function registerAuditRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: AuditQuery }>('/api/audit', { config: { access: 'admin' }, schema: { querystring: querySchema } },
    async (req, reply) => {
      if (req.query.from && req.query.to && req.query.from > req.query.to) {
        return reply.code(400).send({ error: 'validation_failed', message: 'from must not be after to' });
      }
      return queryAudit(db, req.query);
    });
}
