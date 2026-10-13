// Dashboard sessions (D-007): the cookie carries a random token, the DB row is keyed by its SHA-256.
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users, type Role } from '../db/schema.js';
import { randomToken, sha256Hex } from './tokens.js';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser { id: string; email: string; name: string; role: Role }

/** Creates a session and returns the cookie token (never stored). */
export async function createSession(db: Db, userId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ idHash: sha256Hex(token), userId, createdAt: now, expiresAt, lastSeenAt: now });
  // Housekeeping: expired rows of this user (cheap, indexed).
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now)));
  return { token, expiresAt };
}

/** The user behind a cookie token, if the session is unexpired and the user is not disabled. */
export async function sessionUser(db: Db, token: string | undefined, now = new Date()): Promise<SessionUser | null> {
  if (!token || token.length > 128) return null;
  const [row] = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, sha256Hex(token)), gt(sessions.expiresAt, now), isNull(users.disabledAt)));
  return row ?? null;
}

export async function deleteSession(db: Db, token: string | undefined): Promise<void> {
  if (token && token.length <= 128) await db.delete(sessions).where(eq(sessions.idHash, sha256Hex(token)));
}
