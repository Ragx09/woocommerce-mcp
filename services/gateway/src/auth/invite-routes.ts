// /api/invites (AUTH-04/05, docs/API_CONTRACTS.md).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';
import { ROLES, type Role } from '../db/schema.js';
import { requireRole, requireSession } from './guard.js';
import { acceptInvite, checkInvite, createInvite, InviteError, listOpenInvites } from './invites.js';
import { PASSWORD_MAX, passwordProblem } from './password.js';
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';

export interface InviteDeps {
  db: Db;
  publicOrigin: string | undefined;
  cookie: { httpOnly: true; sameSite: 'strict'; secure: boolean; path: '/' };
}

const token = { type: 'string', minLength: 20, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' } as const;

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof InviteError) return reply.code(e.status).send({ error: e.code, message: e.message });
  throw e;
}

export function registerInviteRoutes(app: FastifyInstance, deps: InviteDeps): void {
  const admin = { preHandler: [requireSession(deps.db), requireRole('admin')] };

  app.post<{ Body: { email: string; role?: Role } }>('/api/invites', {
    ...admin,
    schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: {
      email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' },
      role: { type: 'string', enum: [...ROLES] },
    } } },
  }, async (req, reply) => {
    if (!deps.publicOrigin) return reply.code(500).send({ error: 'internal', message: 'PUBLIC_ORIGIN is not configured' });
    try {
      const inv = await createInvite(deps.db, req.user!.id, req.body.email.trim().toLowerCase(), req.body.role ?? 'member');
      req.log.info({ inviteId: inv.id, role: inv.role, by: req.user!.id }, 'invite created');
      // The token sits after '#': browsers never send the fragment to a server, so it stays out of logs.
      return reply.code(201).send({ id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt,
        inviteUrl: `${deps.publicOrigin}/invite#${inv.token}` });
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/invites', admin, async () => listOpenInvites(deps.db));

  // Public (the invitee has no account yet); the 256-bit token is the credential.
  app.post<{ Body: { token: string } }>('/api/invites/check', {
    schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token } } },
  }, async (req, reply) => {
    try { return await checkInvite(deps.db, req.body.token); } catch (e) { return fail(reply, e); }
  });

  app.post<{ Body: { token: string; name: string; password: string } }>('/api/invites/accept', {
    schema: { body: { type: 'object', required: ['token', 'name', 'password'], additionalProperties: false, properties: {
      token, name: { type: 'string', minLength: 1, maxLength: 100 }, password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
    } } },
  }, async (req, reply) => {
    const problem = passwordProblem(req.body.password);
    if (problem) return reply.code(400).send({ error: 'validation_failed', message: problem });
    const name = req.body.name.trim();
    if (!name) return reply.code(400).send({ error: 'validation_failed', message: 'name must not be blank' });
    try {
      const user = await acceptInvite(deps.db, req.body.token, name, req.body.password);
      const { token: sid } = await createSession(deps.db, user.id); // signed in straight away
      reply.setCookie(SESSION_COOKIE, sid, { ...deps.cookie, maxAge: SESSION_TTL_MS / 1000 });
      req.log.info({ userId: user.id, role: user.role }, 'invite accepted');
      return reply.code(201).send({ user });
    } catch (e) { return fail(reply, e); }
  });
}
