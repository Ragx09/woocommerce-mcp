// /api/upstreams (UI-04..07, REQ-GW-01/09/10, docs/API_CONTRACTS.md).
// Reads for every signed-in user: registry row (allowlisted fields only, never a credential) + this
// replica's health + tool count. Members get fewer fields than admins: the URL and auth header name
// describe internal topology and are only needed to edit a server.
// Writes are admin-only: create / edit / enable-disable / delete. The credential is write-only: it is
// encrypted on the way in and never returned. URLs pass the SSRF guard (ssrf.ts) before they are saved.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { encryptCredential, type CredentialKey } from '../crypto/credentials.js';
import type { Db } from '../db/index.js';
import { upstreams, type Upstream } from '../db/schema.js';
import { MAX_DESCRIPTION, SLUG_RE, toPublicName } from '../mcp/naming.js';
import type { ToolDiscovery } from './discovery.js';
import { healthError, type HealthMonitor } from './health.js';
import type { UpstreamPool } from './pool.js';
import { listUpstreams, toPublic } from './repo.js';
import { SsrfError, validateUpstreamUrl, type SsrfPolicy } from './ssrf.js';

export interface UpstreamRouteDeps {
  db: Db;
  pool: Pick<UpstreamPool, 'sync'>;
  discovery: Pick<ToolDiscovery, 'toolsFor'>;
  health: Pick<HealthMonitor, 'get' | 'isUnreachable' | 'checkAll'>;
  /** Needed for writes (credential encryption). */
  key?: CredentialKey;
  ssrf?: SsrfPolicy;
  /** For tests: DNS used by the SSRF check when a URL is saved. */
  lookup?: Parameters<typeof validateUpstreamUrl>[2];
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
// Printable ASCII, like the header the gateway builds from it (pool.ts upstreamHeaders).
const credential = { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[\\x20-\\x7e]+$' } as const;
const fields = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  url: { type: 'string', minLength: 1, maxLength: 2048 },
  authType: { type: 'string', enum: ['none', 'bearer', 'header'] },
  authHeader: { type: ['string', 'null'], pattern: '^[A-Za-z0-9-]{1,64}$' },
} as const;
const createBody = { type: 'object', additionalProperties: false, required: ['name', 'slug', 'url', 'authType'],
  properties: { ...fields, slug: { type: 'string', pattern: SLUG_RE.source }, credential } } as const;
// No slug: it is the tool-name prefix every client relies on (D-005), so it never changes.
const patchBody = { type: 'object', additionalProperties: false, minProperties: 1,
  properties: { ...fields, enabled: { type: 'boolean' }, credential: { anyOf: [credential, { type: 'null' }] } } } as const;

/** Headers the gateway sets itself or that would break the HTTP exchange; not usable as a credential header. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
  'te', 'trailer', 'accept', 'accept-encoding', 'user-agent', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
  'authorization', 'proxy-authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-request-id']);

type CreateBody = { name: string; slug: string; url: string; authType: Upstream['authType']; authHeader?: string | null; credential?: string };
type PatchBody = Partial<Omit<CreateBody, 'slug' | 'credential'>> & { enabled?: boolean; credential?: string | null };

class InputError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

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

/** Auth fields after applying a change; throws InputError when they do not fit together. */
function resolveAuth(prev: Pick<Upstream, 'authType' | 'authHeader' | 'credentialEnc'> | undefined, b: PatchBody):
{ authType: Upstream['authType']; authHeader: string | null; keepCredential: boolean; newCredential: string | null | undefined } {
  const authType = b.authType ?? prev?.authType ?? 'none';
  let authHeader = b.authHeader !== undefined ? b.authHeader : (prev?.authHeader ?? null);
  if (authType !== 'header') authHeader = null;
  if (authType === 'header') {
    if (!authHeader) throw new InputError(400, 'validation_failed', 'authHeader is required when authType is header');
    if (RESERVED_HEADERS.has(authHeader.toLowerCase())) throw new InputError(400, 'validation_failed', `${authHeader} cannot be used as the credential header`);
  }
  if (authType === 'none') {
    if (typeof b.credential === 'string') throw new InputError(400, 'validation_failed', 'a credential needs authType bearer or header');
    return { authType, authHeader, keepCredential: false, newCredential: null };
  }
  const newCredential = b.credential;
  const keepCredential = newCredential === undefined && !!prev?.credentialEnc;
  if (newCredential === null || (newCredential === undefined && !keepCredential)) {
    throw new InputError(400, 'validation_failed', `authType ${authType} needs a credential`);
  }
  return { authType, authHeader, keepCredential, newCredential };
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

  async function view(row: Upstream, isAdmin: boolean) {
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
  }

  /** Registry changed: align the pool now and run a health round in the background (status within seconds). */
  async function changed(): Promise<void> {
    await pool.sync(await listUpstreams(db));
    void health.checkAll();
  }

  async function checkedUrl(url: string): Promise<string> {
    if (!deps.ssrf) throw new Error('SSRF policy not configured');
    return validateUpstreamUrl(url, deps.ssrf, deps.lookup);
  }

  function fail(reply: FastifyReply, e: unknown) {
    if (e instanceof InputError) return reply.code(e.status).send({ error: e.code, message: e.message });
    if (e instanceof SsrfError) return reply.code(400).send({ error: 'ssrf_blocked', message: e.message });
    const pg = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    const code = pg.cause?.code ?? pg.code;
    if (code === '23505') return reply.code(409).send({ error: 'conflict', message: 'a server with this slug already exists' });
    if (code === '23514') return reply.code(400).send({ error: 'validation_failed', message: `invalid value (${pg.cause?.constraint ?? pg.constraint})` });
    throw e;
  }

  app.get('/api/upstreams', { config: { access: 'session' } }, async (req) => {
    const rows = await listUpstreams(db);
    await pool.sync(rows); // a server added a moment ago can be listed before the next health round
    return Promise.all(rows.map((row) => view(row, req.user!.role === 'admin')));
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

  // Create (UI-05).
  app.post<{ Body: CreateBody }>('/api/upstreams', { config: { access: 'admin' }, schema: { body: createBody } }, async (req, reply) => {
    try {
      const b = req.body;
      const auth = resolveAuth(undefined, b);
      const url = await checkedUrl(b.url);
      const [row] = await db.insert(upstreams).values({
        slug: b.slug, name: b.name.trim(), url, authType: auth.authType, authHeader: auth.authHeader,
        credentialEnc: auth.newCredential ? encryptCredential(deps.key!, b.slug, auth.newCredential) : null,
        createdBy: req.user!.id,
      }).returning();
      req.log.info({ upstream: row!.slug, upstreamId: row!.id, by: req.user!.id }, 'upstream created');
      await changed();
      return reply.code(201).send(await view(row!, true));
    } catch (e) { return fail(reply, e); }
  });

  // Edit / enable-disable (UI-06, UI-07). `credential` omitted = keep, string = replace, null = remove.
  app.patch<{ Params: { id: string }; Body: PatchBody }>('/api/upstreams/:id', {
    config: { access: 'admin' }, schema: { params: idParams, body: patchBody },
  }, async (req, reply) => {
    try {
      const [prev] = await db.select().from(upstreams).where(eq(upstreams.id, req.params.id));
      if (!prev) return reply.code(404).send({ error: 'not_found', message: 'no such server' });
      const b = req.body;
      const touchesAuth = b.authType !== undefined || b.authHeader !== undefined || b.credential !== undefined;
      const set: Partial<typeof upstreams.$inferInsert> = {};
      if (b.name !== undefined) set.name = b.name.trim();
      if (b.enabled !== undefined) set.enabled = b.enabled;
      if (b.url !== undefined && b.url !== prev.url) set.url = await checkedUrl(b.url);
      if (touchesAuth) {
        const auth = resolveAuth(prev, b);
        set.authType = auth.authType;
        set.authHeader = auth.authHeader;
        if (!auth.keepCredential) set.credentialEnc = auth.newCredential ? encryptCredential(deps.key!, prev.slug, auth.newCredential) : null;
      }
      const [row] = await db.update(upstreams).set(set).where(eq(upstreams.id, prev.id)).returning();
      req.log.info({ upstream: prev.slug, upstreamId: prev.id, by: req.user!.id, fields: Object.keys(b) }, 'upstream updated');
      await changed();
      return await view(row!, true);
    } catch (e) { return fail(reply, e); }
  });

  // Remove (UI-07). Audit rows stay (they store the slug and id, with no foreign key to this table).
  app.delete<{ Params: { id: string } }>('/api/upstreams/:id', {
    config: { access: 'admin' }, schema: { params: idParams },
  }, async (req, reply) => {
    const [row] = await db.delete(upstreams).where(eq(upstreams.id, req.params.id)).returning({ slug: upstreams.slug });
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'no such server' });
    req.log.info({ upstream: row.slug, upstreamId: req.params.id, by: req.user!.id }, 'upstream deleted');
    await changed();
    return reply.code(204).send();
  });
}
