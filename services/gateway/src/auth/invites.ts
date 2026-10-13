// Invitations (AUTH-04/05, D-007, A-03): an admin creates a one-time link, shown once; nothing is
// emailed. Only the SHA-256 of the token is stored; the token travels in the link's #fragment (never sent
// to a server or logged) and in request bodies, never in a URL path.
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { invites, users, type Role } from '../db/schema.js';
import { hashPassword } from './password.js';
import { randomToken, sha256Hex } from './tokens.js';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export class InviteError extends Error {
  constructor(readonly status: 404 | 409 | 410, readonly code: string, message: string) { super(message); }
}

export async function createInvite(db: Db, by: string, email: string, role: Role, now = new Date()) {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  return db.transaction(async (tx) => {
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken) throw new InviteError(409, 'conflict', 'a user with this email already exists');
    // A new invite replaces any open one for the same email: only the latest link works.
    await tx.delete(invites).where(and(eq(invites.email, email), isNull(invites.usedAt)));
    const [row] = await tx.insert(invites).values({ tokenHash: sha256Hex(token), email, role, createdBy: by, createdAt: now, expiresAt })
      .returning({ id: invites.id });
    return { id: row!.id, token, email, role, expiresAt };
  });
}

/** Open invites for the admin list; no token or hash. */
export async function listOpenInvites(db: Db, now = new Date()) {
  return db.select({ id: invites.id, email: invites.email, role: invites.role, createdAt: invites.createdAt, expiresAt: invites.expiresAt })
    .from(invites).where(and(isNull(invites.usedAt), gt(invites.expiresAt, now))).orderBy(invites.createdAt);
}

async function findUsable(db: Db, token: string, now: Date) {
  const [inv] = await db.select().from(invites).where(eq(invites.tokenHash, sha256Hex(token)));
  if (!inv) throw new InviteError(404, 'not_found', 'invite not found');
  if (inv.usedAt) throw new InviteError(410, 'invite_used', 'this invite has already been used');
  if (inv.expiresAt <= now) throw new InviteError(410, 'invite_expired', 'this invite has expired; ask an admin for a new one');
  return inv;
}

/** What the accept page shows before the user sets a password. */
export async function checkInvite(db: Db, token: string, now = new Date()) {
  const inv = await findUsable(db, token, now);
  return { email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
}

/**
 * Consumes the invite and creates the user, atomically: the conditional UPDATE lets exactly one of two
 * concurrent accepts win; the loser sees 410.
 */
export async function acceptInvite(db: Db, token: string, name: string, password: string, now = new Date()) {
  await findUsable(db, token, now); // precise error for the common cases, before the expensive hash
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [inv] = await tx.update(invites).set({ usedAt: now })
      .where(and(eq(invites.tokenHash, sha256Hex(token)), isNull(invites.usedAt), gt(invites.expiresAt, now)))
      .returning();
    if (!inv) throw new InviteError(410, 'invite_used', 'this invite has already been used');
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
    if (taken) throw new InviteError(409, 'conflict', 'a user with this email already exists');
    const [user] = await tx.insert(users).values({ email: inv.email, name, role: inv.role, passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
    await tx.update(invites).set({ usedBy: user!.id }).where(eq(invites.id, inv.id));
    return user!;
  });
}
