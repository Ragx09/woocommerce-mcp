// Gateway API keys (AUTH-06..09, D-008): `mgw_` + 32 random bytes in base62. Only SHA-256(key) and a
// 12-character display prefix are stored; the key is returned once. Every /mcp request looks the hash up
// (no cache), so a revoked key or a disabled user is refused on the very next request.
import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { apiKeys, users, type Role } from '../db/schema.js';
import { sha256Hex } from './tokens.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const KEY_RE = /^mgw_[0-9A-Za-z]{43}$/;
export const MAX_ACTIVE_KEYS = 20;
const TOUCH_EVERY_MS = 60_000;

/** `mgw_` + 43 base62 characters (256 bits of CSPRNG output). */
export function generateApiKey(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let out = '';
  for (let i = 0; i < 43; i++) { out = B62[Number(n % 62n)]! + out; n /= 62n; }
  return `mgw_${out}`;
}

/** The caller of /mcp. `source`: 'chat' for the dashboard agent's internal token (UI-15), 'oauth' for an OAuth access token (BON-08), else 'mcp'. `grantId` is set for OAuth. */
export interface Principal { userId: string; keyId: string | null; role: Role; email: string; source?: 'mcp' | 'chat' | 'oauth'; grantId?: string }

export class KeyError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string, message: string) { super(message); }
}

/** Issues a key for `userId` (who must exist and be enabled). Returns the plaintext once. */
export async function createApiKey(db: Db, userId: string, name: string, createdBy: string) {
  const key = generateApiKey();
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))).for('update');
    if (!owner) throw new KeyError(404, 'not_found', 'user not found');
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))) as [{ n: number }];
    if (n >= MAX_ACTIVE_KEYS) throw new KeyError(409, 'conflict', `at most ${MAX_ACTIVE_KEYS} active keys per user; revoke one first`);
    const [row] = await tx.insert(apiKeys).values({ userId, name, keyHash: sha256Hex(key), prefix: key.slice(0, 12), createdBy })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
    return { ...row!, key };
  });
}

/** Key list without hashes: own keys, or everyone's for an admin (`all`). */
export async function listApiKeys(db: Db, opts: { userId?: string }) {
  return db.select({
    id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt,
    owner: { id: users.id, email: users.email, name: users.name },
  }).from(apiKeys).innerJoin(users, eq(users.id, apiKeys.userId))
    .where(opts.userId ? eq(apiKeys.userId, opts.userId) : undefined)
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revokes a key. Members may revoke only their own; for anyone else's key the answer is 404, so key ids
 * of other users cannot be probed. Revoking twice is fine (the first time stays recorded).
 */
export async function revokeApiKey(db: Db, keyId: string, by: { id: string; role: Role }): Promise<void> {
  const [key] = await db.select({ userId: apiKeys.userId, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.id, keyId));
  if (!key || (by.role !== 'admin' && key.userId !== by.id)) throw new KeyError(404, 'not_found', 'key not found');
  if (key.revokedAt) return;
  await db.update(apiKeys).set({ revokedAt: new Date(), revokedBy: by.id }).where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)));
}

/** The principal behind a presented key, or null (unknown, malformed, revoked, owner disabled). */
export async function authenticateApiKey(db: Db, presented: string, now = new Date()): Promise<Principal | null> {
  if (!KEY_RE.test(presented)) return null; // cheap reject before touching the DB
  const keyHash = sha256Hex(presented);
  const [row] = await db.select({ keyId: apiKeys.id, userId: users.id, role: users.role, email: users.email })
    .from(apiKeys).innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), isNull(users.disabledAt)));
  if (!row) return null;
  // last_used_at at most once a minute per key: no write on every MCP request.
  const stale = new Date(now.getTime() - TOUCH_EVERY_MS);
  await db.update(apiKeys).set({ lastUsedAt: now })
    .where(and(eq(apiKeys.id, row.keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))));
  return row;
}
