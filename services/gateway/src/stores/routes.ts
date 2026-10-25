// /api/stores (BON-12, A-11, docs/API_CONTRACTS.md): create, list, show, share and delete stores.
// The gateway is the only writer of `stores` (D-026): a create inserts a `provisioning` row, the provisioner
// notices it, builds the store and calls the signed internal API (internal.ts), which registers the store's MCP
// server. A delete flips the row to `desired = absent`, unregisters the MCP server at once and lets the
// provisioner tear the namespace down.
// Who may do what (decided here, never in the UI):
//   create  any signed-in user; 3 stores per member and 5 in total (config), counted under a lock
//   see     admin: all · owner and people on the access list: theirs · everyone else: 404
//   share, tool rule, wp-admin password, delete   owner or admin
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { StoresConfig } from '../config.js';
import type { CredentialKey } from '../crypto/credentials.js';
import type { Db } from '../db/index.js';
import { MEMBER_ACCESS, STORE_NICHES, storeMembers, stores, upstreams, users, type Store, type StoreNiche, type Upstream } from '../db/schema.js';
import { SLUG_RE } from '../mcp/naming.js';
import { decryptStorePassword, STORE_ADMIN_USER, STORE_MEMBER_TOOLS, storeUpstreamSlug } from './internal.js';

/** Every tool woo-mcp offers (services/woo-mcp); a store's tool rule may name only these. */
export const STORE_TOOLS = ['list_products', 'create_product', 'list_orders', 'get_order', 'update_order_status'] as const;
export const MAX_SHARED_MEMBERS = 20;
const RESERVED_SLUGS = new Set(['default', 'store', 'stores', 'platform', 'admin', 'system']);

export interface StoreRouteDeps {
  db: Db;
  key: CredentialKey;
  cfg: StoresConfig;
  /** Multi-store is usable only with the provisioner wired in (signing key present). */
  enabled: boolean;
  /** Called after the registry changed (upstream removed/edited) so this replica drops its pooled connection now. */
  registryChanged?: () => Promise<void>;
}

class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

// Letters, digits and plain punctuation only: these texts become the WordPress title and the home page copy.
const TITLE = '^[\\p{L}\\p{N}][\\p{L}\\p{N} .,\'&-]*$';
const TAGLINE = '^[\\p{L}\\p{N} .,\'&!?:;()-]*$';
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const createBody = { type: 'object', additionalProperties: false, required: ['name', 'niche'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 60, pattern: TITLE },
  niche: { type: 'string', enum: [...STORE_NICHES] },
  tagline: { type: 'string', maxLength: 120, pattern: TAGLINE },
  nicheText: { type: 'string', minLength: 1, maxLength: 60, pattern: TITLE },
} } as const;

/** `Chai Corner!` → `chai-corner`: ASCII letters/digits/hyphens, 3–16 chars, starts with a letter, no `--`. */
export function slugFromName(name: string): string {
  let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (/^[0-9]/.test(s)) s = `s${s}`;
  return s.slice(0, 16).replace(/-+$/g, '');
}
export const slugProblem = (slug: string): string | null =>
  slug.length < 3 ? 'the name needs at least 3 letters or digits' : RESERVED_SLUGS.has(slug) ? 'this name is reserved' : null;

export function registerStoreRoutes(app: FastifyInstance, deps: StoreRouteDeps): void {
  const { db, cfg } = deps;
  const session = { config: { access: 'session' } } as const;

  const urlOf = (slug: string) => (cfg.hostSuffix ? `${cfg.scheme}://${slug}.${cfg.hostSuffix}` : null);

  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof StoreError) return reply.code(e.status).send({ error: e.code, message: e.message });
    throw e;
  }

  type Viewer = { id: string; role: 'admin' | 'member' };
  type Row = { store: Store; owner: { id: string; name: string }; upstream: Upstream | null };

  /** Stores the viewer may see, not deleted: admin all; others owned or shared with them. */
  async function visible(v: Viewer, onlyId?: string): Promise<Row[]> {
    const rows = await db.select({ store: stores, ownerName: users.name, upstream: upstreams })
      .from(stores).innerJoin(users, eq(users.id, stores.ownerId)).leftJoin(upstreams, eq(upstreams.storeId, stores.id))
      .where(and(ne(stores.status, 'deleted'), onlyId ? eq(stores.id, onlyId) : undefined))
      .orderBy(asc(stores.createdAt));
    if (v.role === 'admin') return rows.map((r) => ({ store: r.store, owner: { id: r.store.ownerId, name: r.ownerName }, upstream: r.upstream }));
    const shared = new Set((await db.select({ id: storeMembers.storeId }).from(storeMembers).where(eq(storeMembers.userId, v.id))).map((r) => r.id));
    return rows.filter((r) => r.store.ownerId === v.id || shared.has(r.store.id))
      .map((r) => ({ store: r.store, owner: { id: r.store.ownerId, name: r.ownerName }, upstream: r.upstream }));
  }

  const canManage = (v: Viewer, s: Store) => v.role === 'admin' || s.ownerId === v.id;

  async function view(v: Viewer, r: Row) {
    const s = r.store;
    const manage = canManage(v, s);
    const url = urlOf(s.slug);
    const base = {
      id: s.id, slug: s.slug, name: s.name, tagline: s.tagline, niche: s.niche, nicheText: s.nicheText,
      status: s.status, statusReason: s.statusReason, url,
      owner: r.owner, role: s.ownerId === v.id ? 'owner' : manage ? 'admin' : 'shared',
      createdAt: s.createdAt.toISOString(), readyAt: s.readyAt?.toISOString() ?? null,
      isDefault: false, canManage: manage,
    };
    if (!manage) return base;
    const members = await db.select({ userId: users.id, name: users.name, email: users.email, addedAt: storeMembers.createdAt })
      .from(storeMembers).innerJoin(users, eq(users.id, storeMembers.userId)).where(eq(storeMembers.storeId, s.id)).orderBy(asc(storeMembers.createdAt));
    return {
      ...base,
      adminUrl: url && s.status === 'ready' ? `${url}/wp-admin/` : null,
      passwordAvailable: s.adminPasswordEnc !== null,
      members: members.map((m) => ({ ...m, addedAt: m.addedAt.toISOString() })),
      // The rule people on the access list get for this store's tools; null until the MCP server is registered.
      toolRule: r.upstream ? { memberAccess: r.upstream.memberAccess, memberTools: r.upstream.memberTools } : null,
      tools: STORE_TOOLS, readOnlyTools: STORE_MEMBER_TOOLS,
      ...(v.role === 'admin' ? { namespace: `store-${s.slug}`, desired: s.desired } : {}),
    };
  }

  const defaultStore = () => cfg.defaultStoreUrl ? [{
    id: 'default', slug: 'default', name: 'Default store', tagline: '', niche: null, nicheText: null, status: 'ready', statusReason: null,
    url: cfg.defaultStoreUrl, owner: null, role: 'shared', createdAt: null, readyAt: null, isDefault: true, canManage: false,
  }] : [];

  async function one(v: Viewer, id: string, reply: FastifyReply): Promise<Row | undefined> {
    const [r] = await visible(v, id);
    if (!r) { reply.code(404).send({ error: 'not_found', message: 'no such store' }); return undefined; }
    return r;
  }

  const viewer = (req: { user: { id: string; role: 'admin' | 'member' } | null }): Viewer => ({ id: req.user!.id, role: req.user!.role });

  app.get('/api/stores', session, async (req) => {
    const v = viewer(req);
    const rows = await visible(v);
    const limits = { maxPerMember: cfg.maxPerMember, maxTotal: cfg.maxTotal };
    const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(stores).where(ne(stores.status, 'deleted')) as [{ n: number }];
    const mine = rows.filter((r) => r.store.ownerId === v.id).length;
    return {
      enabled: deps.enabled && cfg.maxTotal > 0,
      limits: { ...limits, total, mine },
      stores: [...defaultStore(), ...(await Promise.all(rows.map((r) => view(v, r))))],
    };
  });

  // The slug a name would get, before creating (it cannot be edited afterwards).
  app.get<{ Querystring: { name: string } }>('/api/stores/slug', {
    ...session, schema: { querystring: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 60 } } } },
  }, async (req) => {
    const slug = slugFromName(req.query.name);
    const problem = slugProblem(slug);
    if (problem) return { slug, available: false, reason: problem };
    const taken = await slugTaken(slug);
    return { slug, available: !taken, reason: taken ? 'a store with this name already exists' : null };
  });

  async function slugTaken(slug: string): Promise<boolean> {
    const [s] = await db.select({ id: stores.id }).from(stores).where(and(eq(stores.slug, slug), ne(stores.status, 'deleted')));
    if (s) return true;
    const [u] = await db.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.slug, storeUpstreamSlug(slug)));
    return !!u;
  }

  app.post<{ Body: { name: string; niche: StoreNiche; tagline?: string; nicheText?: string } }>('/api/stores', {
    ...session, schema: { body: createBody, headers: { type: 'object', properties: { 'idempotency-key': { type: 'string' } } } },
  }, async (req, reply) => {
    const v = viewer(req);
    try {
      if (!deps.enabled || cfg.maxTotal === 0) throw new StoreError(503, 'stores_unavailable', 'creating stores is not available on this installation');
      const requestKey = String(req.headers['idempotency-key'] ?? '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestKey)) throw new StoreError(400, 'validation_failed', 'Idempotency-Key header (8–64 letters, digits, - or _) is required');
      const b = req.body;
      const name = b.name.trim().replace(/\s+/g, ' ');
      const tagline = (b.tagline ?? '').trim().replace(/\s+/g, ' ');
      const nicheText = b.nicheText?.trim().replace(/\s+/g, ' ');
      if ((b.niche === 'custom') !== (nicheText !== undefined)) {
        throw new StoreError(400, 'validation_failed', b.niche === 'custom' ? 'nicheText is required for the custom niche' : 'nicheText is only for the custom niche');
      }
      const slug = slugFromName(name);
      const problem = slugProblem(slug);
      if (problem) throw new StoreError(400, 'validation_failed', problem);

      const result = await db.transaction(async (tx) => {
        // One create at a time decides the caps: two requests cannot both take the last slot.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('stores:create'))`);
        const [same] = await tx.select().from(stores).where(and(eq(stores.ownerId, v.id), eq(stores.requestKey, requestKey)));
        if (same) {
          if (same.name !== name || same.niche !== b.niche || same.slug !== slug) {
            throw new StoreError(409, 'idempotency_conflict', 'this Idempotency-Key was used for a different store');
          }
          return { store: same, created: false };
        }
        const live = await tx.select({ ownerId: stores.ownerId }).from(stores).where(ne(stores.status, 'deleted'));
        if (live.length >= cfg.maxTotal) throw new StoreError(409, 'store_limit', `the platform is at its limit of ${cfg.maxTotal} stores; delete one first`);
        const mine = live.filter((s) => s.ownerId === v.id).length;
        if (v.role === 'member' && mine >= cfg.maxPerMember) {
          throw new StoreError(409, 'store_limit', `you already own ${mine} stores (limit ${cfg.maxPerMember}); delete one first`);
        }
        // A deleted store's name is free again: its row is removed (audit rows keep the slug).
        await tx.delete(stores).where(and(eq(stores.slug, slug), eq(stores.status, 'deleted')));
        const [clash] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.slug, slug));
        const [up] = await tx.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.slug, storeUpstreamSlug(slug)));
        if (clash || up || !SLUG_RE.test(storeUpstreamSlug(slug))) {
          throw new StoreError(409, 'slug_taken', `a store named "${slug}" already exists; choose another name`);
        }
        const [row] = await tx.insert(stores).values({ slug, name, tagline, niche: b.niche, nicheText: nicheText ?? null, ownerId: v.id, requestKey }).returning();
        return { store: row!, created: true };
      });
      if (result.created) req.log.info({ store: result.store.slug, by: v.id }, 'store requested');
      const [r] = await visible(v, result.store.id);
      return reply.code(result.created ? 202 : 200).send(await view(v, r!));
    } catch (e) { return fail(reply, e); }
  });

  app.get<{ Params: { id: string } }>('/api/stores/:id', { ...session, schema: { params: idParams } }, async (req, reply) => {
    const v = viewer(req);
    const r = await one(v, req.params.id, reply);
    return r ? view(v, r) : undefined;
  });

  // Delete: owner or admin, and the slug typed back. Unregisters the MCP server first (its tools are gone on the
  // next request), then hands the teardown to the provisioner.
  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>('/api/stores/:id', {
    ...session, schema: { params: idParams, querystring: { type: 'object', properties: { confirm: { type: 'string', maxLength: 40 } } } },
  }, async (req, reply) => {
    const v = viewer(req);
    try {
      const r = await one(v, req.params.id, reply);
      if (!r) return;
      if (!canManage(v, r.store)) throw new StoreError(403, 'forbidden', 'only the owner or an admin can delete a store');
      if (req.query.confirm !== r.store.slug) throw new StoreError(400, 'confirmation_mismatch', `type the store's name (${r.store.slug}) to confirm`);
      await db.transaction(async (tx) => {
        await tx.delete(upstreams).where(eq(upstreams.storeId, r.store.id));
        await tx.update(stores).set({ desired: 'absent', status: 'deleting', statusReason: null, adminPasswordEnc: null })
          .where(and(eq(stores.id, r.store.id), ne(stores.status, 'deleted')));
      });
      await deps.registryChanged?.();
      req.log.info({ store: r.store.slug, by: v.id }, 'store deletion requested');
      const [after] = await visible(v, r.store.id);
      return reply.code(202).send(after ? await view(v, after) : { id: r.store.id, status: 'deleted' });
    } catch (e) { return fail(reply, e); }
  });

  // Access list: people the owner shares the store with (they get the store's tool rule, read-only by default).
  app.post<{ Params: { id: string }; Body: { email: string } }>('/api/stores/:id/members', {
    ...session, schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['email'],
      properties: { email: { type: 'string', maxLength: 254 } } } },
  }, async (req, reply) => {
    const v = viewer(req);
    try {
      const r = await one(v, req.params.id, reply);
      if (!r) return;
      if (!canManage(v, r.store)) throw new StoreError(403, 'forbidden', 'only the owner or an admin can share a store');
      if (r.store.desired !== 'present') throw new StoreError(409, 'conflict', 'this store is being deleted');
      const email = req.body.email.trim().toLowerCase();
      const [u] = await db.select({ id: users.id, role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.email, email));
      if (!u || u.disabledAt) throw new StoreError(404, 'user_not_found', 'no active member with this email');
      if (u.id === r.store.ownerId) throw new StoreError(409, 'conflict', 'the owner already has full access');
      if (u.role === 'admin') throw new StoreError(409, 'conflict', 'admins already have access to every store');
      await db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from ${stores} where ${stores.id} = ${r.store.id} for update`);
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(storeMembers).where(eq(storeMembers.storeId, r.store.id)) as [{ n: number }];
        if (n >= MAX_SHARED_MEMBERS) throw new StoreError(409, 'conflict', `a store can be shared with at most ${MAX_SHARED_MEMBERS} people`);
        await tx.insert(storeMembers).values({ storeId: r.store.id, userId: u.id, addedBy: v.id }).onConflictDoNothing();
      });
      req.log.info({ store: r.store.slug, member: u.id, by: v.id }, 'store shared');
      const [after] = await visible(v, r.store.id);
      return reply.code(201).send(await view(v, after!));
    } catch (e) { return fail(reply, e); }
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/stores/:id/members/:userId', {
    ...session, schema: { params: { type: 'object', required: ['id', 'userId'], properties: { id: { type: 'string', format: 'uuid' }, userId: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const v = viewer(req);
    try {
      const r = await one(v, req.params.id, reply);
      if (!r) return;
      // A person on the list may remove themself; everything else is for the owner or an admin.
      if (!canManage(v, r.store) && req.params.userId !== v.id) throw new StoreError(403, 'forbidden', 'only the owner or an admin can change who a store is shared with');
      await db.delete(storeMembers).where(and(eq(storeMembers.storeId, r.store.id), eq(storeMembers.userId, req.params.userId)));
      req.log.info({ store: r.store.slug, member: req.params.userId, by: v.id }, 'store access removed');
      return reply.code(204).send();
    } catch (e) { return fail(reply, e); }
  });

  // What people on the access list may do with this store's tools (BON-01 rule, per store).
  app.patch<{ Params: { id: string }; Body: { memberAccess: Upstream['memberAccess']; memberTools?: string[] } }>('/api/stores/:id', {
    ...session, schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['memberAccess'], properties: {
      memberAccess: { type: 'string', enum: MEMBER_ACCESS },
      memberTools: { type: 'array', maxItems: STORE_TOOLS.length, uniqueItems: true, items: { type: 'string', enum: [...STORE_TOOLS] } },
    } } },
  }, async (req, reply) => {
    const v = viewer(req);
    try {
      const r = await one(v, req.params.id, reply);
      if (!r) return;
      if (!canManage(v, r.store)) throw new StoreError(403, 'forbidden', 'only the owner or an admin can change the tool rule');
      if (!r.upstream) throw new StoreError(409, 'conflict', 'the store\'s MCP server is not registered yet');
      const tools = req.body.memberAccess === 'selected' ? (req.body.memberTools ?? []) : [];
      if (req.body.memberAccess === 'selected' && tools.length === 0) throw new StoreError(400, 'validation_failed', 'choose at least one tool, or pick "none"');
      await db.update(upstreams).set({ memberAccess: req.body.memberAccess, memberTools: tools }).where(eq(upstreams.id, r.upstream.id));
      await deps.registryChanged?.();
      req.log.info({ store: r.store.slug, rule: req.body.memberAccess, by: v.id }, 'store tool rule changed');
      const [after] = await visible(v, r.store.id);
      return await view(v, after!);
    } catch (e) { return fail(reply, e); }
  });

  // The wp-admin password, once. POST (not GET): it changes state, and no cache or link may repeat it. The
  // update that wipes the stored value is also what hands it out, so two requests cannot both receive it.
  app.post<{ Params: { id: string } }>('/api/stores/:id/admin-password', { ...session, schema: { params: idParams } }, async (req, reply) => {
    const v = viewer(req);
    try {
      const r = await one(v, req.params.id, reply);
      if (!r) return;
      if (!canManage(v, r.store)) throw new StoreError(403, 'forbidden', 'only the owner or an admin can see the wp-admin password');
      // The row lock makes "read, wipe, hand out" one step: two requests cannot both receive the password, and a
      // failure to decrypt rolls the wipe back.
      const password = await db.transaction(async (tx) => {
        const [row] = await tx.select({ enc: stores.adminPasswordEnc, slug: stores.slug }).from(stores).where(eq(stores.id, r.store.id)).for('update');
        if (!row?.enc) return null;
        const plain = decryptStorePassword(deps.key, row.slug, row.enc);
        await tx.update(stores).set({ adminPasswordEnc: null, adminPasswordViewedAt: new Date() }).where(eq(stores.id, r.store.id));
        return plain;
      });
      if (password === null) {
        throw new StoreError(410, 'already_viewed', r.store.status === 'ready'
          ? 'the wp-admin password was already shown; use "Lost password?" on the store\'s login page' : 'the wp-admin password is not available yet');
      }
      req.log.info({ store: r.store.slug, by: v.id }, 'store wp-admin password viewed');
      return { username: STORE_ADMIN_USER, password };
    } catch (e) { return fail(reply, e); }
  });
}

