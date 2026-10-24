// GW-03/13/14: register the chart's upstreams (woo, everything, github) on first start, so a fresh
// install works without setup.
// Rules ("never overwrite admin edits"):
//  - seeded once; a record in app_meta remembers it, so an upstream the admin deleted is not re-created;
//  - while the row is untouched since seeding (updated_at unchanged), URL and credential follow the
//    chart values/Secret, so a rotated woo-mcp token is picked up on the next start;
//  - once an admin edits the row, the seeder leaves it alone for good.
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { appMeta, upstreams, type AuthType } from '../db/schema.js';
import { encryptCredential, type CredentialKey } from '../crypto/credentials.js';

export interface SeedUpstream {
  slug: string;
  name: string;
  url: string;
  authType: AuthType;
  authHeader?: string | null;
  credential?: string | null;
  /** BON-01: tools members may use; set only when the row is created (later it is the admin's). Omitted → all. */
  memberTools?: string[];
}

export type SeedResult = 'created' | 'refreshed' | 'unchanged' | 'admin-edited' | 'admin-deleted';

interface SeedRecord {
  upstreamId: string;
  seededAt: string; // = the row's updated_at after the seeder's last write
  fingerprint: string; // hash of url + auth + credential from values/Secret
}

const SEED_LOCK_ID = '7400183211'; // advisory lock shared by replicas (differs from the migration lock)

const fingerprint = (s: SeedUpstream) =>
  createHash('sha256').update(JSON.stringify([s.url, s.authType, s.authHeader ?? null, s.credential ?? null])).digest('hex');

export async function seedUpstream(db: Db, key: CredentialKey, s: SeedUpstream): Promise<SeedResult> {
  const metaKey = `seed.upstream.${s.slug}`;
  const fp = fingerprint(s);
  const credentialEnc = s.credential ? encryptCredential(key, s.slug, s.credential) : null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_ID})`);
    const [meta] = await tx.select().from(appMeta).where(eq(appMeta.key, metaKey));
    const record = meta?.value as SeedRecord | undefined;

    const writeRecord = async (upstreamId: string, updatedAt: Date) => {
      const value: SeedRecord = { upstreamId, seededAt: updatedAt.toISOString(), fingerprint: fp };
      await tx.insert(appMeta).values({ key: metaKey, value })
        .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
    };

    if (!record) {
      // First start. An admin might already have created this slug by hand: then do not touch it.
      const [existing] = await tx.select({ id: upstreams.id, updatedAt: upstreams.updatedAt })
        .from(upstreams).where(eq(upstreams.slug, s.slug));
      if (existing) {
        await writeRecord(existing.id, new Date(0)); // never equal to its updated_at → treated as admin-owned
        return 'admin-edited';
      }
      const [row] = await tx.insert(upstreams).values({
        slug: s.slug, name: s.name, url: s.url, authType: s.authType,
        authHeader: s.authHeader ?? null, credentialEnc,
        ...(s.memberTools ? { memberAccess: 'selected' as const, memberTools: s.memberTools } : {}),
      }).returning({ id: upstreams.id, updatedAt: upstreams.updatedAt });
      await writeRecord(row!.id, row!.updatedAt);
      return 'created';
    }

    const [row] = await tx.select({ id: upstreams.id, updatedAt: upstreams.updatedAt })
      .from(upstreams).where(eq(upstreams.id, record.upstreamId));
    if (!row) return 'admin-deleted';
    if (row.updatedAt.toISOString() !== record.seededAt) return 'admin-edited';
    if (record.fingerprint === fp) return 'unchanged';

    const [updated] = await tx.update(upstreams)
      .set({ url: s.url, authType: s.authType, authHeader: s.authHeader ?? null, credentialEnc })
      .where(eq(upstreams.id, row.id))
      .returning({ updatedAt: upstreams.updatedAt });
    await writeRecord(row.id, updated!.updatedAt);
    return 'refreshed';
  });
}

/** SEED_WOO_URL / SEED_WOO_TOKEN (/ SEED_WOO_MEMBER_TOOLS) from the chart. Returns null when seeding is turned off. */
export function loadWooSeed(env: NodeJS.ProcessEnv = process.env): SeedUpstream | null {
  const url = env.SEED_WOO_URL?.trim();
  if (!url) return null;
  const token = env.SEED_WOO_TOKEN?.trim();
  if (!token) throw new Error('SEED_WOO_TOKEN is required when SEED_WOO_URL is set');
  const seed: SeedUpstream = { slug: 'woo', name: env.SEED_WOO_NAME?.trim() || 'WooCommerce', url, authType: 'bearer', credential: token };
  // BON-01: e.g. "list_products,list_orders,get_order" → members read-only on the store. Empty → all tools.
  const memberTools = (env.SEED_WOO_MEMBER_TOOLS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (memberTools.length) seed.memberTools = memberTools;
  return seed;
}

export interface SeedPlan {
  seeds: SeedUpstream[];
  /** Upstreams turned on in the chart but left out, with a reason that is safe to log. */
  skipped: { slug: string; reason: string }[];
}

/**
 * Every upstream the chart asks for, in registry order: woo (GW-03), everything (GW-13, no auth),
 * github (GW-14, PAT as bearer). The woo token is required (the store is the core); a missing GitHub
 * PAT only skips github, so an install without one still starts.
 */
export function loadSeeds(env: NodeJS.ProcessEnv = process.env): SeedPlan {
  const plan: SeedPlan = { seeds: [], skipped: [] };
  const woo = loadWooSeed(env);
  if (woo) plan.seeds.push(woo);

  const evUrl = env.SEED_EVERYTHING_URL?.trim();
  if (evUrl) plan.seeds.push({ slug: 'everything', name: env.SEED_EVERYTHING_NAME?.trim() || 'Everything (reference)', url: evUrl, authType: 'none' });

  const ghUrl = env.SEED_GITHUB_URL?.trim();
  if (ghUrl) {
    const pat = env.SEED_GITHUB_TOKEN?.trim();
    if (pat) plan.seeds.push({ slug: 'github', name: env.SEED_GITHUB_NAME?.trim() || 'GitHub', url: ghUrl, authType: 'bearer', credential: pat });
    else plan.skipped.push({ slug: 'github', reason: 'SEED_GITHUB_TOKEN is empty (set GITHUB_MCP_PAT in .env and rotate upstream-seed)' });
  }
  return plan;
}
