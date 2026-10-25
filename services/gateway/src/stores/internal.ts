// D-026: the provisioner's only way to change anything in the gateway. Routes under /internal are not in the
// Ingress, the NetworkPolicy admits only the provisioner pod, and every request must carry a valid HMAC
// signature over its exact body (signing.ts). The gateway stays the single writer of `stores`:
//   POST /internal/stores/:id/ready    {wooMcpUrl, wooMcpToken, adminUser, adminPassword}
//        → woo-mcp token encrypted like any upstream credential, upstream `woo-<slug>` registered (owner-scoped,
//          members read-only by default), wp-admin password kept encrypted for one view, status ready (BON-13)
//   POST /internal/stores/:id/failed   {reason}   → status failed with a short reason (timeout, Helm error)
//   POST /internal/stores/:id/deleted  {}         → status deleted (namespace and release are gone)
// All three are idempotent: a retried call after a provisioner restart gets 200 and changes nothing more.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { stores, upstreams, type Store } from '../db/schema.js';
import { encryptCredential, type CredentialKey } from '../crypto/credentials.js';
import { STORE_WOO_MCP_HOST } from '../upstreams/ssrf.js';
import { SIGNATURE_HEADER, verify } from './signing.js';

/** Tools members on a store's access list get by default (A-11: shared read-only). */
export const STORE_MEMBER_TOOLS = ['list_products', 'list_orders', 'get_order'];

export interface InternalDeps { db: Db; key: CredentialKey; signingKey: Buffer }

export const storeUpstreamSlug = (slug: string): string => `woo-${slug}`;
const storeAad = (slug: string) => `store:${slug}`;
export const encryptStorePassword = (key: CredentialKey, slug: string, password: string) => encryptCredential(key, storeAad(slug), password);

const SAFE_REASON = /[^\x20-\x7E]/g; // printable ASCII only in stored reasons

export function registerInternalStoreRoutes(app: FastifyInstance, deps: InternalDeps): void {
  void app.register(async (scope) => {
    // The signature is over the raw bytes, so this scope parses JSON itself after verifying.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => done(null, body));
    scope.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const path = req.url.split('?')[0]!;
      if (!verify(deps.signingKey, req.headers[SIGNATURE_HEADER] as string | undefined, req.method, path, raw)) {
        req.log.warn({ path }, 'internal request with a missing or invalid signature refused');
        return reply.code(401).send({ error: 'invalid_signature', message: 'missing or invalid signature' });
      }
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { return reply.code(400).send({ error: 'bad_request', message: 'invalid JSON' }); }
    });

    const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
    const load = async (id: string): Promise<Store | undefined> => (await deps.db.select().from(stores).where(eq(stores.id, id)))[0];

    scope.post<{ Params: { id: string }; Body: { wooMcpUrl?: unknown; wooMcpToken?: unknown; adminUser?: unknown; adminPassword?: unknown } }>(
      '/internal/stores/:id/ready', { schema: { params } }, async (req, reply) => {
        const b = req.body;
        if (typeof b.wooMcpUrl !== 'string' || typeof b.wooMcpToken !== 'string' || typeof b.adminPassword !== 'string'
          || b.wooMcpToken.length < 32 || b.wooMcpToken.length > 256 || b.adminPassword.length < 16 || b.adminPassword.length > 128) {
          return reply.code(400).send({ error: 'bad_request', message: 'wooMcpUrl, wooMcpToken and adminPassword are required' });
        }
        return deps.db.transaction(async (tx) => {
          const [s] = await tx.select().from(stores).where(eq(stores.id, req.params.id)).for('update');
          if (!s) return reply.code(404).send({ error: 'not_found', message: 'store not found' });
          let url: URL;
          try { url = new URL(b.wooMcpUrl as string); } catch { return reply.code(400).send({ error: 'bad_request', message: 'wooMcpUrl is not a URL' }); }
          // Only this store's own woo-mcp: the provisioner cannot point an upstream anywhere else.
          if (url.protocol !== 'http:' || url.hostname !== `woo-mcp.store-${s.slug}.svc.cluster.local` || !STORE_WOO_MCP_HOST.test(url.hostname) || url.pathname !== '/mcp') {
            return reply.code(400).send({ error: 'bad_request', message: 'wooMcpUrl must be this store\'s woo-mcp Service' });
          }
          if (s.status === 'ready') return { status: 'ready' }; // retried call
          if (s.status !== 'provisioning' || s.desired !== 'present') return reply.code(409).send({ error: 'conflict', message: `store is ${s.status}` });
          const slug = storeUpstreamSlug(s.slug);
          const credentialEnc = encryptCredential(deps.key, slug, b.wooMcpToken as string);
          const [existing] = await tx.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.slug, slug));
          if (existing) {
            await tx.update(upstreams).set({ url: url.toString(), credentialEnc, storeId: s.id, enabled: true }).where(eq(upstreams.id, existing.id));
          } else {
            await tx.insert(upstreams).values({ slug, name: `${s.name} (store)`.slice(0, 100), url: url.toString(), authType: 'bearer', credentialEnc,
              memberAccess: 'selected', memberTools: STORE_MEMBER_TOOLS, storeId: s.id, createdBy: s.ownerId });
          }
          await tx.update(stores).set({ status: 'ready', statusReason: null, readyAt: new Date(),
            adminPasswordEnc: encryptStorePassword(deps.key, s.slug, b.adminPassword as string), adminPasswordViewedAt: null })
            .where(eq(stores.id, s.id));
          req.log.info({ store: s.slug, upstream: slug }, 'store ready: upstream registered');
          return { status: 'ready' };
        });
      });

    scope.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/internal/stores/:id/failed', { schema: { params } }, async (req, reply) => {
      const reason = typeof req.body.reason === 'string' ? req.body.reason.replace(SAFE_REASON, ' ').trim().slice(0, 300) : '';
      if (!reason) return reply.code(400).send({ error: 'bad_request', message: 'reason is required' });
      const [row] = await deps.db.update(stores).set({ status: 'failed', statusReason: reason })
        .where(and(eq(stores.id, req.params.id), eq(stores.status, 'provisioning'))).returning({ slug: stores.slug });
      if (!row) {
        const s = await load(req.params.id);
        if (!s) return reply.code(404).send({ error: 'not_found', message: 'store not found' });
        return { status: s.status }; // already decided (ready, failed, deleting): nothing to do
      }
      req.log.warn({ store: row.slug, reason }, 'store provisioning failed');
      return { status: 'failed' };
    });

    scope.post<{ Params: { id: string } }>('/internal/stores/:id/deleted', { schema: { params } }, async (req, reply) => {
      const s = await load(req.params.id);
      if (!s) return reply.code(404).send({ error: 'not_found', message: 'store not found' });
      if (s.desired !== 'absent') return reply.code(409).send({ error: 'conflict', message: 'store is not being deleted' });
      if (s.status !== 'deleted') {
        await deps.db.update(stores).set({ status: 'deleted', deletedAt: new Date(), adminPasswordEnc: null }).where(eq(stores.id, s.id));
        req.log.info({ store: s.slug }, 'store deleted');
      }
      return { status: 'deleted' };
    });
  }, { prefix: '' });
}
