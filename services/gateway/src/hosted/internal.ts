// BON-10: the provisioner's signed calls for hosted servers (same signature rules as stores, stores/internal.ts):
//   POST /internal/hosted/:id/ready    {url}     → registers the server as upstream `<slug>` (no credential: its
//                                                  NetworkPolicy admits only the gateway), members get no access until an admin allows it
//   POST /internal/hosted/:id/failed   {reason}
//   POST /internal/hosted/:id/deleted  {}
// All idempotent. `ready` accepts only this server's own Service address.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { hostedServers, upstreams } from '../db/schema.js';
import { parseRuntime } from '../runtime.js';
import { signedInternalScope } from '../stores/internal.js';
import { HOSTED_SERVER_HOST } from '../upstreams/ssrf.js';

const SAFE_REASON = /[^\x20-\x7E]/g;

export function registerInternalHostedRoutes(app: FastifyInstance, deps: { db: Db; signingKey: Buffer }): void {
  const { db } = deps;
  signedInternalScope(app, deps.signingKey, (scope) => {
    const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

    scope.post<{ Params: { id: string }; Body: { url?: unknown } }>('/internal/hosted/:id/ready', { schema: { params } }, async (req, reply) => {
      if (typeof req.body.url !== 'string') return reply.code(400).send({ error: 'bad_request', message: 'url is required' });
      const body = req.body as { url: string };
      return db.transaction(async (tx) => {
        const [h] = await tx.select().from(hostedServers).where(eq(hostedServers.id, req.params.id)).for('update');
        if (!h) return reply.code(404).send({ error: 'not_found', message: 'hosted server not found' });
        let url: URL;
        try { url = new URL(body.url); } catch { return reply.code(400).send({ error: 'bad_request', message: 'url is not a URL' }); }
        if (url.protocol !== 'http:' || url.hostname !== `server.hosted-${h.slug}.svc.cluster.local` || !HOSTED_SERVER_HOST.test(url.hostname)
          || url.port !== '' || url.pathname !== h.path || url.search || url.username || url.password) {
          return reply.code(400).send({ error: 'bad_request', message: 'url must be this server\'s own Service address' });
        }
        if (h.status === 'ready') return { status: 'ready' };
        if (h.status !== 'provisioning' || h.desired !== 'present') return reply.code(409).send({ error: 'conflict', message: `server is ${h.status}` });
        const [existing] = await tx.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.slug, h.slug));
        if (existing) return reply.code(409).send({ error: 'conflict', message: 'an upstream with this slug already exists' });
        // memberAccess 'none': an unknown image's tools are for admins until an admin decides otherwise (PATCH /api/upstreams/:id).
        await tx.insert(upstreams).values({ slug: h.slug, name: h.name, url: url.toString(), authType: 'none', memberAccess: 'none', memberTools: [],
          hostedId: h.id, createdBy: h.createdBy });
        await tx.update(hostedServers).set({ status: 'ready', statusReason: null, readyAt: new Date() }).where(eq(hostedServers.id, h.id));
        req.log.info({ hosted: h.slug }, 'hosted server ready: upstream registered');
        return { status: 'ready' };
      });
    });

    scope.post<{ Params: { id: string }; Body: { reason?: unknown } }>('/internal/hosted/:id/failed', { schema: { params } }, async (req, reply) => {
      const reason = typeof req.body.reason === 'string' ? req.body.reason.replace(SAFE_REASON, ' ').trim().slice(0, 300) : '';
      if (!reason) return reply.code(400).send({ error: 'bad_request', message: 'reason is required' });
      const [row] = await db.update(hostedServers).set({ status: 'failed', statusReason: reason })
        .where(and(eq(hostedServers.id, req.params.id), eq(hostedServers.status, 'provisioning'))).returning({ slug: hostedServers.slug });
      if (!row) {
        const [h] = await db.select().from(hostedServers).where(eq(hostedServers.id, req.params.id));
        return h ? { status: h.status } : reply.code(404).send({ error: 'not_found', message: 'hosted server not found' });
      }
      req.log.warn({ hosted: row.slug, reason }, 'hosted server provisioning failed');
      return { status: 'failed' };
    });

    scope.post<{ Params: { id: string } }>('/internal/hosted/:id/runtime', { schema: { params } }, async (req, reply) => {
      const snap = parseRuntime(req.body);
      if (!snap) return reply.code(400).send({ error: 'bad_request', message: 'pods {ready,total} and optional quota numbers are required' });
      const [row] = await db.update(hostedServers).set({ runtime: snap, runtimeAt: new Date() })
        .where(and(eq(hostedServers.id, req.params.id), eq(hostedServers.status, 'ready'))).returning({ id: hostedServers.id });
      if (!row) { const [h] = await db.select({ id: hostedServers.id }).from(hostedServers).where(eq(hostedServers.id, req.params.id)); if (!h) return reply.code(404).send({ error: 'not_found', message: 'hosted server not found' }); }
      return { status: row ? 'recorded' : 'ignored' };
    });

    // BON-14 recovery: the namespace of a ready hosted server is gone. Failed with that reason, server unregistered.
    scope.post<{ Params: { id: string } }>('/internal/hosted/:id/missing', { schema: { params } }, async (req, reply) => {
      const out = await db.transaction(async (tx) => {
        const [h] = await tx.select().from(hostedServers).where(eq(hostedServers.id, req.params.id)).for('update');
        if (!h) return null;
        if (h.status !== 'ready' || h.desired !== 'present') return h.status;
        await tx.delete(upstreams).where(eq(upstreams.hostedId, h.id));
        await tx.update(hostedServers).set({ status: 'failed', statusReason: 'the server\'s namespace was removed outside the platform; delete the server here to clean up', runtime: null, runtimeAt: null })
          .where(eq(hostedServers.id, h.id));
        req.log.warn({ hosted: h.slug }, 'hosted namespace missing: server marked failed, unregistered');
        return 'failed';
      });
      return out ? { status: out } : reply.code(404).send({ error: 'not_found', message: 'hosted server not found' });
    });

    scope.post<{ Params: { id: string } }>('/internal/hosted/:id/deleted', { schema: { params } }, async (req, reply) => {
      const [h] = await db.select().from(hostedServers).where(eq(hostedServers.id, req.params.id));
      if (!h) return reply.code(404).send({ error: 'not_found', message: 'hosted server not found' });
      if (h.desired !== 'absent') return reply.code(409).send({ error: 'conflict', message: 'hosted server is not being deleted' });
      await db.delete(upstreams).where(eq(upstreams.hostedId, h.id));
      if (h.status !== 'deleted') {
        await db.update(hostedServers).set({ status: 'deleted', deletedAt: new Date(), secretEnvEnc: null }).where(eq(hostedServers.id, h.id));
        req.log.info({ hosted: h.slug }, 'hosted server deleted');
      }
      return { status: 'deleted' };
    });
  });
}
