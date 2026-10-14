// /api/users and DELETE /api/invites/:id (UI-09, REQ-AUTH-01/02, docs/API_CONTRACTS.md). Admin only.
// Users are never deleted (audit rows point at them); an admin disables them instead. Disabling takes
// effect on the next request everywhere: sessions are deleted now, and session/API-key checks refuse
// disabled users anyway (sessions.ts, api-keys.ts).
// Lock-out guards: an admin cannot disable or demote themself, and the last active admin cannot lose
// that status. The check runs in one transaction with the active admins locked (FOR UPDATE), so two
// admins demoting each other at the same moment cannot both succeed.
import { and, count, eq, isNull, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { apiKeys, invites, ROLES, sessions, users, type Role } from '../db/schema.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

class UserError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function registerUserRoutes(app: FastifyInstance, db: Db): void {
  const admin = { config: { access: 'admin' } } as const;

  // Members with what an admin needs to judge them: role, status, active keys, last key use.
  app.get('/api/users', admin, async () => {
    const keyStats = db.select({
      userId: apiKeys.userId,
      activeKeys: count(apiKeys.id).as('active_keys'),
      lastKeyUseAt: max(apiKeys.lastUsedAt).as('last_key_use_at'),
    }).from(apiKeys).where(isNull(apiKeys.revokedAt)).groupBy(apiKeys.userId).as('k');
    const rows = await db.select({
      id: users.id, email: users.email, name: users.name, role: users.role,
      disabledAt: users.disabledAt, createdAt: users.createdAt,
      activeKeys: sql<number>`coalesce(${keyStats.activeKeys}, 0)::int`, lastKeyUseAt: keyStats.lastKeyUseAt,
    }).from(users).leftJoin(keyStats, eq(keyStats.userId, users.id)).orderBy(users.createdAt);
    return rows;
  });

  app.patch<{ Params: { id: string }; Body: { disabled?: boolean; role?: Role } }>('/api/users/:id', {
    ...admin,
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      disabled: { type: 'boolean' }, role: { type: 'string', enum: [...ROLES] },
    } } },
  }, async (req, reply) => {
    const { disabled, role } = req.body;
    try {
      const updated = await db.transaction(async (tx) => {
        const activeAdmins = (await tx.select({ id: users.id }).from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt))).for('update')).map((r) => r.id);
        // The guard checked the caller's role before this transaction; re-check under the lock, so an admin
        // demoted a moment ago cannot finish a request that was already in flight.
        if (!activeAdmins.includes(req.user!.id)) throw new UserError(403, 'forbidden', 'not allowed for your role');
        const [target] = await tx.select().from(users).where(eq(users.id, req.params.id)).for('update');
        if (!target) throw new UserError(404, 'not_found', 'no such user');
        const losesAdmin = activeAdmins.includes(target.id) && (disabled === true || role === 'member');
        if (losesAdmin && target.id === req.user!.id) throw new UserError(409, 'conflict', 'you cannot disable or demote yourself');
        if (losesAdmin && activeAdmins.length <= 1) throw new UserError(409, 'conflict', 'the last active admin cannot be disabled or demoted');
        const set: Partial<typeof users.$inferInsert> = {};
        if (role !== undefined) set.role = role;
        if (disabled !== undefined) set.disabledAt = disabled ? (target.disabledAt ?? new Date()) : null;
        const [row] = await tx.update(users).set(set).where(eq(users.id, target.id))
          .returning({ id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt });
        if (disabled) await tx.delete(sessions).where(eq(sessions.userId, target.id)); // signed out everywhere now
        return row!;
      });
      req.log.info({ userId: updated.id, by: req.user!.id, fields: Object.keys(req.body) }, 'user updated');
      return updated;
    } catch (e) {
      if (e instanceof UserError) return reply.code(e.status).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  // Withdraw an open invite: its link stops working at once (404 on check/accept).
  app.delete<{ Params: { id: string } }>('/api/invites/:id', { ...admin, schema: { params: idParams } }, async (req, reply) => {
    const [row] = await db.delete(invites).where(and(eq(invites.id, req.params.id), isNull(invites.usedAt))).returning({ id: invites.id });
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'no such open invite' });
    req.log.info({ inviteId: row.id, by: req.user!.id }, 'invite withdrawn');
    return reply.code(204).send();
  });
}
