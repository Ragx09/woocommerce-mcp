// /api/hosted (BON-10, D-029, docs/API_CONTRACTS.md): admins add an MCP server by container image. The gateway
// records the wish (a `hosted_servers` row, `provisioning`); the provisioner runs the image in its own namespace
// `hosted-<slug>` (non-root, read-only filesystem, no token, gateway-only ingress, no egress unless allowed) and
// reports back through the signed internal API (internal.ts), which registers the server as upstream `<slug>`.
// Admin only, like every other change to the server registry. Secret environment values are write-only: encrypted
// on the way in (key derived from the gateway↔provisioner key), never returned, never logged.
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { encryptCredential, type CredentialKey } from '../crypto/credentials.js';
import type { Db } from '../db/index.js';
import { hostedServers, upstreams, type HostedServer } from '../db/schema.js';
import { hostedEnvKey } from '../stores/signing.js';

export interface HostedRouteDeps {
  db: Db;
  /** The gateway↔provisioner signing key; null → hosting is off (nothing would ever become ready). */
  signingKey: Buffer | null;
  /** Allowed image prefixes, e.g. `ghcr.io/acme`, `registry.k8s.io`. Empty → hosting is off. */
  registries: readonly string[];
  max: number;
  registryChanged?: () => Promise<void>;
}

class HostedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$/;
export const SLUG_HOSTED_RE = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = /^(KUBERNETES_|LD_|PATH$|HOME$|HOSTNAME$)/;
const RESERVED_SLUGS = new Set(['default', 'platform', 'store', 'stores', 'hosted', 'admin', 'system', 'mcp']);
const MAX_PLAIN = 30;
const MAX_SECRET = 20;

/** Why an image reference is refused, or null. A registry is allowed by prefix (`ghcr.io/acme` matches `ghcr.io/acme/tool:1`). */
export function imageProblem(image: string, registries: readonly string[]): string | null {
  if (!IMAGE_RE.test(image) || image.length > 255) return 'image must look like registry/path:tag (or @sha256:digest), lower-case';
  if (image.includes('..') || image.includes('//') || image.includes('/.')) return 'image must look like registry/path:tag (or @sha256:digest), lower-case';
  const tag = /:([A-Za-z0-9._-]+)$/.exec(image)?.[1];
  if (tag === 'latest') return 'use a fixed version tag or a digest, not :latest';
  const first = image.split('/')[0]!;
  if (!image.includes('/') || (!first.includes('.') && !first.includes(':'))) return 'name the registry in full (e.g. ghcr.io/owner/image:1.2.3)';
  if (!registries.some((r) => image.startsWith(`${r}/`))) return `registry not allowed (allowed: ${registries.join(', ') || 'none configured'})`;
  return null;
}

const envMap = (max: number, valueMax: number) => ({ type: 'object', maxProperties: max, additionalProperties: { type: 'string', maxLength: valueMax, pattern: '^[\\x20-\\x7e]*$' } }) as const;
const createBody = { type: 'object', additionalProperties: false, required: ['name', 'slug', 'image', 'port'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  slug: { type: 'string', minLength: 3, maxLength: 16 },
  image: { type: 'string', minLength: 3, maxLength: 255 },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  path: { type: 'string', maxLength: 128, pattern: '^/[A-Za-z0-9._~/-]{0,127}$' },
  env: envMap(MAX_PLAIN, 2048),
  secretEnv: envMap(MAX_SECRET, 4096),
  allowEgress: { type: 'boolean' },
} } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

export function registerHostedRoutes(app: FastifyInstance, deps: HostedRouteDeps): void {
  const { db } = deps;
  const admin = { config: { access: 'admin' } } as const;
  const enabled = () => !!deps.signingKey && deps.registries.length > 0 && deps.max > 0;
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof HostedError) return reply.code(e.status).send({ error: e.code, message: e.message });
    throw e;
  };

  const view = (h: HostedServer, upstreamId: string | null) => ({
    id: h.id, slug: h.slug, name: h.name, image: h.image, port: h.port, path: h.path,
    env: h.env, secretEnvNames: h.secretEnvNames, allowEgress: h.allowEgress,
    status: h.status, statusReason: h.statusReason, namespace: `hosted-${h.slug}`, upstreamId,
    runtime: h.runtime ? { ...h.runtime, at: h.runtimeAt?.toISOString() ?? null } : null,
    createdAt: h.createdAt.toISOString(), readyAt: h.readyAt?.toISOString() ?? null,
  });
  const listRows = async (id?: string) => {
    const rows = await db.select({ h: hostedServers, up: upstreams.id }).from(hostedServers)
      .leftJoin(upstreams, eq(upstreams.hostedId, hostedServers.id))
      .where(and(ne(hostedServers.status, 'deleted'), id ? eq(hostedServers.id, id) : undefined)).orderBy(asc(hostedServers.createdAt));
    return rows.map((r) => view(r.h, r.up));
  };

  app.get('/api/hosted', admin, async () => ({
    enabled: enabled(), registries: deps.registries, max: deps.max, servers: await listRows(),
  }));

  app.get<{ Params: { id: string } }>('/api/hosted/:id', { ...admin, schema: { params: idParams } }, async (req, reply) => {
    const [one] = await listRows(req.params.id);
    return one ?? reply.code(404).send({ error: 'not_found', message: 'no such hosted server' });
  });

  app.post<{ Body: { name: string; slug: string; image: string; port: number; path?: string; env?: Record<string, string>; secretEnv?: Record<string, string>; allowEgress?: boolean } }>(
    '/api/hosted', { ...admin, schema: { body: createBody } }, async (req, reply) => {
      try {
        if (!enabled()) throw new HostedError(503, 'hosting_unavailable', 'hosting servers by image is not set up on this installation (no allowed registries or no provisioner)');
        const b = req.body;
        const name = b.name.trim();
        if (!name) throw new HostedError(400, 'validation_failed', 'name is required');
        if (!SLUG_HOSTED_RE.test(b.slug) || b.slug.includes('--') || RESERVED_SLUGS.has(b.slug)) {
          throw new HostedError(400, 'validation_failed', 'slug: 3–16 lower-case letters, digits and single hyphens, starting with a letter (not a reserved word)');
        }
        const problem = imageProblem(b.image, deps.registries);
        if (problem) throw new HostedError(400, problem.startsWith('registry not allowed') ? 'registry_not_allowed' : 'validation_failed', problem);
        const env = b.env ?? {};
        const secretEnv = b.secretEnv ?? {};
        const names = [...Object.keys(env), ...Object.keys(secretEnv)];
        for (const n of names) {
          if (!ENV_NAME.test(n)) throw new HostedError(400, 'validation_failed', `environment variable name ${JSON.stringify(n.slice(0, 40))} must be UPPER_CASE letters, digits and _`);
          if (RESERVED_ENV.test(n)) throw new HostedError(400, 'validation_failed', `environment variable ${n} is reserved`);
        }
        if (new Set(names).size !== names.length) throw new HostedError(400, 'validation_failed', 'a variable cannot be both plain and secret');
        const row = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hosted:create'))`);
          const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(hostedServers).where(ne(hostedServers.status, 'deleted')) as [{ n: number }];
          if (n >= deps.max) throw new HostedError(409, 'hosted_limit', `at most ${deps.max} hosted servers; delete one first`);
          await tx.delete(hostedServers).where(and(eq(hostedServers.slug, b.slug), eq(hostedServers.status, 'deleted')));
          const [clash] = await tx.select({ id: hostedServers.id }).from(hostedServers).where(eq(hostedServers.slug, b.slug));
          const [up] = await tx.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.slug, b.slug));
          if (clash || up) throw new HostedError(409, 'slug_taken', `a server with the slug "${b.slug}" already exists`);
          const secretEnvEnc = Object.keys(secretEnv).length
            ? encryptCredential(hostedEnvKey(deps.signingKey!) as CredentialKey, `hosted:${b.slug}`, JSON.stringify(secretEnv)) : null;
          const [r] = await tx.insert(hostedServers).values({ slug: b.slug, name, image: b.image, port: b.port, path: b.path ?? '/mcp', env,
            secretEnvEnc, secretEnvNames: Object.keys(secretEnv).sort(), allowEgress: b.allowEgress ?? false, createdBy: req.user!.id }).returning();
          return r!;
        });
        // The image and variable names are logged; values never are.
        req.log.info({ hosted: row.slug, image: row.image, by: req.user!.id, env: Object.keys(env), secretEnv: Object.keys(secretEnv) }, 'hosted server requested');
        return reply.code(202).send(view(row, null));
      } catch (e) { return fail(reply, e); }
    });

  // Delete: unregisters the server at once (its tools leave /mcp on the next request), then the provisioner removes the
  // namespace, Secret, Service and release. The stored secret values are wiped now.
  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>('/api/hosted/:id', {
    ...admin, schema: { params: idParams, querystring: { type: 'object', properties: { confirm: { type: 'string', maxLength: 40 } } } },
  }, async (req, reply) => {
    try {
      const [h] = await db.select().from(hostedServers).where(and(eq(hostedServers.id, req.params.id), ne(hostedServers.status, 'deleted')));
      if (!h) throw new HostedError(404, 'not_found', 'no such hosted server');
      if (req.query.confirm !== h.slug) throw new HostedError(400, 'confirmation_mismatch', `type the server's slug (${h.slug}) to confirm`);
      await db.transaction(async (tx) => {
        await tx.delete(upstreams).where(eq(upstreams.hostedId, h.id));
        await tx.update(hostedServers).set({ desired: 'absent', status: 'deleting', statusReason: null, secretEnvEnc: null })
          .where(eq(hostedServers.id, h.id));
      });
      await deps.registryChanged?.();
      req.log.info({ hosted: h.slug, by: req.user!.id }, 'hosted server deletion requested');
      const [after] = await listRows(h.id);
      return reply.code(202).send(after ?? { id: h.id, status: 'deleted' });
    } catch (e) { return fail(reply, e); }
  });
}
