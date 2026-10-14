// GET /api/upstreams and GET /api/upstreams/:id/tools (UI-04, REQ-GW-09/10, docs/API_CONTRACTS.md).
// Read-only views for every signed-in user: registry row (allowlisted fields only, never a
// credential) + this replica's health + tool count. Members get fewer fields than admins: the URL and
// auth header name describe internal topology and are only needed to edit a server.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { upstreams, type Upstream } from '../db/schema.js';
import { MAX_DESCRIPTION, toPublicName } from '../mcp/naming.js';
import type { ToolDiscovery } from './discovery.js';
import { healthError, type HealthMonitor } from './health.js';
import type { UpstreamPool } from './pool.js';
import { listUpstreams, toPublic } from './repo.js';

export interface UpstreamRouteDeps {
  db: Db;
  pool: Pick<UpstreamPool, 'sync'>;
  discovery: Pick<ToolDiscovery, 'toolsFor'>;
  health: Pick<HealthMonitor, 'get' | 'isUnreachable'>;
}

export interface ToolView {
  publicName: string;
  name: string;
  title: string | null;
  description: string;
  /** Top-level parameter names, required ones first. */
  params: { name: string; required: boolean }[];
}

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

function toolView(slug: string, t: Tool): ToolView {
  const props = Object.keys((t.inputSchema?.properties ?? {}) as Record<string, unknown>);
  const required = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
  return {
    publicName: toPublicName(slug, t.name),
    name: t.name,
    title: t.title ?? null,
    description: (t.description ?? '').slice(0, MAX_DESCRIPTION),
    params: props.map((name) => ({ name, required: required.has(name) }))
      .sort((a, b) => Number(b.required) - Number(a.required)),
  };
}

export function registerUpstreamRoutes(app: FastifyInstance, deps: UpstreamRouteDeps): void {
  const { db, pool, discovery, health } = deps;

  /** Tools of an enabled, reachable upstream (cache ≤ 60 s, else one live list within the 3 s budget). */
  async function tools(row: Upstream): Promise<{ tools: Tool[] } | { error: string }> {
    if (health.isUnreachable(row.id)) return { error: health.get(row).lastError ?? `upstream ${row.slug} unreachable` };
    try {
      return { tools: await discovery.toolsFor(row) };
    } catch (e) {
      return { error: healthError(row.slug, e) };
    }
  }

  app.get('/api/upstreams', { config: { access: 'session' } }, async (req) => {
    const rows = await listUpstreams(db);
    await pool.sync(rows); // a server added a moment ago can be listed before the next health round
    const isAdmin = req.user!.role === 'admin';
    return Promise.all(rows.map(async (row) => {
      const h = health.get(row);
      const t = row.enabled ? await tools(row) : undefined;
      const pub = toPublic(row);
      const base = {
        id: pub.id, name: pub.name, slug: pub.slug, enabled: pub.enabled,
        status: h.status, lastError: h.lastError,
        lastCheckedAt: h.lastCheckedAt?.toISOString() ?? null, lastOkAt: h.lastOkAt?.toISOString() ?? null,
        toolCount: t && 'tools' in t ? t.tools.length : null,
      };
      return isAdmin ? { ...base, url: pub.url, authType: pub.authType, authHeader: pub.authHeader,
        hasCredential: pub.hasCredential, createdAt: pub.createdAt, updatedAt: pub.updatedAt } : base;
    }));
  });

  app.get<{ Params: { id: string } }>('/api/upstreams/:id/tools', {
    config: { access: 'session' }, schema: { params: idParams },
  }, async (req, reply) => {
    const [row] = await db.select().from(upstreams).where(eq(upstreams.id, req.params.id));
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'no such server' });
    if (!row.enabled) return reply.code(409).send({ error: 'upstream_disabled', message: `server ${row.slug} is disabled` });
    await pool.sync(await listUpstreams(db));
    const t = await tools(row);
    if ('error' in t) return reply.code(502).send({ error: 'upstream_unreachable', message: t.error });
    return t.tools.filter((x) => x.name).map((x) => toolView(row.slug, x));
  });
}
