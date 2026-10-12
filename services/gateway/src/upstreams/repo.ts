// Read access to registered upstreams. `toPublic` is the only shape that leaves the gateway
// (API responses, logs): an allowlist, so the encrypted credential can never be serialized (T-03).
import { asc } from 'drizzle-orm';
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
