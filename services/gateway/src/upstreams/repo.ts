// Read access to registered upstreams. `toPublic` is the only shape that leaves the gateway
// (API responses, logs): an allowlist, so the encrypted credential can never be serialized (T-03).
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { upstreams, type Upstream } from '../db/schema.js';

export interface PublicUpstream {
  id: string;
  name: string;
  slug: string;
  url: string;
  enabled: boolean;
  authType: Upstream['authType'];
  authHeader: string | null;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublic(u: Upstream): PublicUpstream {
  return {
    id: u.id,
    name: u.name,
    slug: u.slug,
    url: u.url,
    enabled: u.enabled,
    authType: u.authType,
    authHeader: u.authHeader,
    hasCredential: u.credentialEnc !== null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

/** Oldest first, so the seeded WooCommerce server is listed first on a fresh install. */
export function listUpstreams(db: Db): Promise<Upstream[]> {
  return db.select().from(upstreams).orderBy(asc(upstreams.createdAt), asc(upstreams.slug));
}

/**
 * Enable or disable an upstream (GW-11; used by PATCH /api/upstreams/:id). The change lives only in the
 * DB: every replica reads the registry on each /mcp request and health round, so all of them stop
 * listing and calling it on their next request, and close its pooled connection (version changes via
 * updated_at). Returns the updated row, or undefined when the id does not exist.
 */
export async function setUpstreamEnabled(db: Db, id: string, enabled: boolean): Promise<Upstream | undefined> {
  const [row] = await db.update(upstreams).set({ enabled }).where(eq(upstreams.id, id)).returning();
  return row;
}
