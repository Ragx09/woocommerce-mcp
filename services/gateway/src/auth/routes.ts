// /api/auth/* (AUTH-02/03, docs/API_CONTRACTS.md). The browser only ever holds an httpOnly session
// cookie; tokens never reach JavaScript.
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { LoginLimiter } from './limiter.js';
import { PASSWORD_MAX, verifyPassword } from './password.js';
import { registerOriginCheck, requireSession } from './guard.js';
import { registerInviteRoutes } from './invite-routes.js';
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';

export interface AuthDeps {
  db: Db;
  /** Secure cookie flag: true behind HTTPS (prod). */
  cookieSecure: boolean;
  /** The dashboard's origin, e.g. https://app.example.com; mutating /api requests from other origins → 403. */
  publicOrigin: string | undefined;
  limiter?: LoginLimiter;
}

const loginBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 254 },
    password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
  },
} as const;

export async function registerAuth(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('user', null);
  registerOriginCheck(app, deps.publicOrigin);
  const limiter = deps.limiter ?? new LoginLimiter();
  const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: deps.cookieSecure, path: '/' } as const;

  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', { schema: { body: loginBody } }, async (req, reply) => {
    const email = req.body.email.trim().toLowerCase();
    const wait = limiter.retryAfter(req.ip, email);
    if (wait > 0) {
      req.log.warn({ ip: req.ip }, 'login rate limited');
      return reply.code(429).header('retry-after', String(wait))
        .send({ error: 'rate_limited', message: `too many failed logins; try again in ${wait} s` });
    }
    const [user] = await deps.db.select().from(users).where(eq(users.email, email));
    // Same work and the same answer for: unknown email, wrong password, disabled user.
    const ok = await verifyPassword(user?.passwordHash ?? null, req.body.password);
    if (!user || !ok || user.disabledAt) {
      limiter.fail(req.ip, email);
      req.log.warn({ ip: req.ip, known: Boolean(user) }, 'login failed');
      return reply.code(401).send({ error: 'invalid_credentials', message: 'wrong email or password' });
    }
    limiter.succeed(req.ip, email);
    const { token } = await createSession(deps.db, user.id);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: SESSION_TTL_MS / 1000 });
    req.log.info({ userId: user.id, role: user.role }, 'login');
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  // Idempotent: always clears the cookie; deletes the session row when there is one.
  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(deps.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return reply.code(204).send();
  });

  app.get('/api/me', { preHandler: requireSession(deps.db) }, async (req) => req.user);

  registerInviteRoutes(app, { db: deps.db, publicOrigin: deps.publicOrigin, cookie: cookieOpts });
}
