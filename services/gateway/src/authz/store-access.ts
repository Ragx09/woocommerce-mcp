// BON-14 (A-11, REQ-BON-05/06): who may use a created store's MCP server. The store's upstream row carries
// `storeId`; the decision needs the caller, not only the role:
//   admin                         → every tool (like any server)
//   owner of the store            → every tool
//   on the store's access list    → the upstream's member rule (default: read-only, widened per store)
//   anyone else                   → nothing: hidden in tools/list, refused in tools/call (audited as rejected)
// Servers without a store (woo, github, everything, admin-added) are decided by role alone, as before.
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { storeMembers, stores, type Role, type Upstream } from '../db/schema.js';

export type StoreAccess = Map<string, 'owner' | 'shared'>;

/** The stores (not deleted) the user owns or that were shared with them. One query, no caching: a change applies on the next request. */
export async function loadStoreAccess(db: Db, userId: string): Promise<StoreAccess> {
  const owned = await db.select({ id: stores.id }).from(stores).where(and(eq(stores.ownerId, userId), ne(stores.status, 'deleted')));
  const shared = await db.select({ id: storeMembers.storeId }).from(storeMembers)
    .innerJoin(stores, eq(stores.id, storeMembers.storeId))
    .where(and(eq(storeMembers.userId, userId), ne(stores.status, 'deleted')));
  const out: StoreAccess = new Map();
  for (const s of shared) out.set(s.id, 'shared');
  for (const s of owned) out.set(s.id, 'owner');
  return out;
}

/**
 * The role to apply to this upstream for this caller, or null when the caller may not even see it.
 * `owner` gets 'admin' (all tools), `shared` gets 'member' (the upstream's member rule).
 */
export function roleFor(row: Pick<Upstream, 'storeId'>, role: Role, access: StoreAccess | undefined): Role | null {
  if (!row.storeId) return role;
  if (role === 'admin') return 'admin';
  const a = access?.get(row.storeId);
  return a === 'owner' ? 'admin' : a === 'shared' ? 'member' : null;
}

export const needsStoreAccess = (rows: Pick<Upstream, 'storeId'>[]): boolean => rows.some((r) => r.storeId !== null);

