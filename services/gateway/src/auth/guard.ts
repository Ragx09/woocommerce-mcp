// Request guards for /api (AUTH-03, AUTH-10). Authorization is decided here, on the server — never by
// what the dashboard shows or hides.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import type { Role } from '../db/schema.js';
import { SESSION_COOKIE, sessionUser, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession; null on routes without it. */
    user: SessionUser | null;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth (D-007, T-12), on top of SameSite=Strict: a state-changing /api request that
 * comes from a browser must come from our own origin. Browsers always send `Origin` on cross-origin
 * POST/PUT/PATCH/DELETE and `Sec-Fetch-Site` on every request; a request with neither is not from a
 * browser page, so no ambient cookie can be abused by a third-party site. With no public origin
 * configured, every browser-originated mutation is refused (fail closed).
 */
export function originAllowed(req: FastifyRequest, publicOrigin: string | undefined): boolean {
  if (!MUTATING.has(req.method)) return true;
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (origin !== undefined) return publicOrigin !== undefined && origin === publicOrigin;
  if (site !== undefined) return site === 'same-origin' || site === 'none';
  return true;
}

export function registerOriginCheck(app: FastifyInstance, publicOrigin: string | undefined): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (originAllowed(req, publicOrigin)) return;
    req.log.warn({ origin: String(req.headers.origin ?? '').slice(0, 200), site: req.headers['sec-fetch-site'] }, 'cross-origin /api request refused');
    return reply.code(403).send({ error: 'forbidden', message: 'cross-origin request refused' });
  });
}

/** preHandler: 401 unless the request carries a valid, unexpired session of an enabled user. */
export function requireSession(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    req.user = await sessionUser(db, req.cookies?.[SESSION_COOKIE]);
    if (!req.user) return reply.code(401).send({ error: 'unauthenticated', message: 'log in first' });
  };
}

/** preHandler after requireSession: 403 unless the user has one of the roles. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return reply.code(403).send({ error: 'forbidden', message: 'not allowed for your role' });
    }
  };
}
