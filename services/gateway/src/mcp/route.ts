// GW-06: the gateway's own MCP endpoint, POST /mcp (stateless Streamable HTTP, D-002).
// - tools/list: reload enabled upstreams from the DB (so every replica agrees), discover their tools
//   (GW-05), and return them under public names (GW-07).
// - tools/call (GW-08): public name → upstream + tool (via ToolIndex, so shortened names work) →
//   forward → the upstream result unchanged. Unknown/disabled → JSON-RPC error; problems reaching
//   the upstream → an isError result the model can read. Arguments and results are never logged.
// - Auth: per-user API key (`Authorization: Bearer mgw_…`), looked up by hash on every request (AUTH-08);
//   the caller (user, key) is attached to the request and to every log line.
//   Unknown, malformed, revoked keys and keys of disabled users → 401. The dashboard chat agent uses a
//   short-lived internal token instead (UI-15, auth/internal-token.ts), accepted only over loopback. The inbound Authorization header
//   is only checked here; it is never forwarded upstream (T-04).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { VERSION } from '../app.js';
import type { Principal } from '../auth/api-keys.js';
import { isLoopback } from '../auth/internal-token.js';
import type { AuditEvent, AuditMethod, AuditSink, CallContext } from '../audit/audit.js';
import type { AuditOutcome } from '../db/schema.js';
import type { Upstream } from '../db/schema.js';
import type { ToolDiscovery } from '../upstreams/discovery.js';
import type { HealthMonitor } from '../upstreams/health.js';
import {
  isSafeCallRetry, safeReason, UpstreamTimeoutError, UpstreamUnavailableError, withDeadline, type UpstreamPool,
} from '../upstreams/pool.js';
import { aggregateTools } from './aggregate.js';
import { parsePublicName, ToolIndex } from './naming.js';

/** Default budget for one tools/call (docs/MCP_DESIGN.md §6); set by UPSTREAM_CALL_TIMEOUT_MS. */
const CALL_TIMEOUT_MS = 15_000;

export interface McpDeps {
  /**
   * Bearer token → the calling user and key, or null (AUTH-08: per-user API keys, looked up on every request;
   * UI-15: internal chat tokens, accepted only when `loopback` — the TCP peer is this pod).
   */
  authenticate: (bearer: string, conn: { loopback: boolean }) => Promise<Principal | null>;
  loadUpstreams: () => Promise<Upstream[]>;
  pool: UpstreamPool;
  discovery: ToolDiscovery;
  /** GW-10: unreachable upstreams fail fast; call outcomes are reported back. */
  health?: HealthMonitor;
  /** Budget for one forwarded tools/call, including connecting and a reconnect (GW-09). */
  callTimeoutMs?: number;
  /** Audit log (AUTH-13): one event per tools/call, tools/list and refused request. Omitted → not audited. */
  audit?: AuditSink;
}

/** The token of an `Authorization: Bearer <token>` header, or '' (scheme is case-insensitive per RFC 9110). */
function bearerToken(header: string | undefined): string {
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1]! : '';
}

async function loadRows(deps: McpDeps, log: FastifyBaseLogger, method: string): Promise<Upstream[]> {
  try {
    return await deps.loadUpstreams();
  } catch (e) {
    log.error({ err: (e as Error).message }, `${method}: loading upstreams failed`);
    throw new McpError(ErrorCode.InternalError, 'upstream registry unavailable'); // no DB details to clients
  }
}

const unknownTool = (name: string) =>
  new McpError(ErrorCode.InvalidParams, `unknown tool: ${name.slice(0, 80)}`, { code: 'unknown_tool' });

const errorResult = (code: string, message: string): CallToolResult =>
  ({ isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] });

/** Maps a failed forward to an isError result; messages carry no URLs or credentials. */
function callFailure(slug: string, e: unknown, budgetMs: number): { outcome: AuditOutcome; code: string; result: CallToolResult } {
  if (e instanceof UpstreamUnavailableError) {
    return { outcome: 'unreachable', code: 'upstream_unreachable', result: errorResult('upstream_unreachable', e.message) };
  }
  if (e instanceof UpstreamTimeoutError || (e instanceof McpError && e.code === ErrorCode.RequestTimeout)) {
    const ms = e instanceof UpstreamTimeoutError ? e.ms : budgetMs;
    return { outcome: 'timeout', code: 'upstream_timeout', result: errorResult('upstream_timeout', `upstream ${slug} did not answer within ${ms / 1000} s`) };
  }
  return { outcome: 'error', code: 'upstream_error', result: errorResult('upstream_error', `upstream ${slug} failed: ${safeReason(e)}`) };
}

/** What one tools/call did, filled in as the handler goes; logged and audited exactly once at the end. */
interface CallRecord {
  upstreamId: string | null;
  upstreamSlug: string | null;
  tool: string;
  outcome: AuditOutcome;
  errorCode: string | null;
}

/** A JSON-RPC error thrown by a handler → audit outcome and code. */
function thrownOutcome(e: unknown): { outcome: AuditOutcome; code: string } {
  if (e instanceof McpError) {
    if (e.code === ErrorCode.InternalError) return { outcome: 'error', code: 'registry_unavailable' };
    const code = (e.data as { code?: string } | undefined)?.code;
    return { outcome: 'rejected', code: code ?? 'invalid_request' };
  }
  return { outcome: 'error', code: 'internal' };
}

function buildServer(deps: McpDeps, log: FastifyBaseLogger, ctx: CallContext): Server {
  const server = new Server({ name: 'mcp-gateway', version: VERSION }, { capabilities: { tools: {} } });
  const callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const audit = (method: AuditMethod, started: number, e: Omit<AuditEvent, 'requestId' | 'userId' | 'apiKeyId' | 'source' | 'method' | 'durationMs'>) =>
    deps.audit?.({ requestId: ctx.requestId, userId: ctx.userId, apiKeyId: ctx.keyId, source: ctx.source, method, durationMs: Date.now() - started, ...e });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    const rec: CallRecord = { upstreamId: null, upstreamSlug: parsePublicName(req.params.name)?.slug ?? null,
      tool: req.params.name, outcome: 'error', errorCode: 'internal' };
    try {
      return await forwardCall(req.params.name, req.params.arguments, rec);
    } catch (e) {
      ({ outcome: rec.outcome, code: rec.errorCode } = thrownOutcome(e));
      throw e;
    } finally {
      log.info({ upstream: rec.upstreamSlug ?? undefined, tool: rec.tool, outcome: rec.outcome, ms: Date.now() - started }, 'tools/call');
      await audit('tools/call', started, { upstreamId: rec.upstreamId, upstreamSlug: rec.upstreamSlug, tool: rec.tool,
        outcome: rec.outcome, errorCode: rec.errorCode });
    }
  });

  /** Resolves and forwards one call; sets the outcome on `rec` for every result it returns. */
  async function forwardCall(publicName: string, args: Record<string, unknown> | undefined, rec: CallRecord): Promise<CallToolResult> {
    const settle = (outcome: AuditOutcome, errorCode: string | null) => { rec.outcome = outcome; rec.errorCode = errorCode; };
    const parsed = parsePublicName(publicName);
    if (!parsed) throw unknownTool(publicName);
    const rows = await loadRows(deps, log, 'tools/call');
    const row = rows.find((r) => r.slug === parsed.slug);
    if (!row) throw unknownTool(publicName);
    rec.upstreamId = row.id;
    if (!row.enabled) {
      throw new McpError(ErrorCode.InvalidParams, `upstream ${row.slug} is disabled`, { code: 'upstream_disabled' });
    }
    await deps.pool.sync(rows);

    // Never the argument values or the result (they can hold personal data or secrets); at debug level
    // the argument names help to debug a failing call (GW-17).
    log.debug({ upstream: row.slug, tool: publicName, argNames: Object.keys(args ?? {}) }, 'tools/call arguments');
    if (deps.health?.isUnreachable(row.id)) {
      // Fail fast: the health loop brings it back within one interval once it answers again.
      settle('unreachable', 'upstream_unreachable');
      return errorResult('upstream_unreachable', deps.health.get(row).lastError ?? `upstream ${row.slug} unreachable`);
    }
    let tool: string | undefined;
    try {
      const index = new ToolIndex();
      for (const t of await deps.discovery.toolsFor(row)) if (t.name) index.add(row.id, row.slug, t.name);
      tool = index.resolve(publicName)?.tool;
    } catch (e) {
      const f = callFailure(row.slug, e, callTimeoutMs);
      settle(f.outcome, f.code);
      return f.result;
    }
    if (!tool) throw unknownTool(publicName);
    rec.tool = tool;

    try {
      // One deadline for connect + call (+ the reconnect, when that is safe): the client never waits longer.
      const result = await withDeadline(row.slug, callTimeoutMs, (signal) => deps.pool.withClient(
        row.id,
        (c) => c.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: callTimeoutMs }),
        isSafeCallRetry,
      ));
      settle(result.isError ? 'tool_error' : 'ok', null);
      deps.health?.reportOk(row);
      return result as CallToolResult;
    } catch (e) {
      // A slow tool says nothing about health; only "could not connect" marks the upstream unreachable.
      if (e instanceof UpstreamUnavailableError) deps.health?.reportFailure(row, e);
      const f = callFailure(row.slug, e, callTimeoutMs);
      settle(f.outcome, f.code);
      return f.result;
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const started = Date.now();
    let rows: Upstream[];
    try {
      rows = await loadRows(deps, log, 'tools/list');
    } catch (e) {
      await audit('tools/list', started, { upstreamId: null, upstreamSlug: null, tool: null, outcome: 'error', errorCode: 'registry_unavailable' });
      throw e;
    }
    await deps.pool.sync(rows);
    const result = await deps.discovery.discover();
    const { tools, index } = aggregateTools(result);
    for (const c of index.conflicts) {
      log.warn({ upstream: c.slug, tool: c.tool, publicName: c.publicName, kept: c.keptTool }, 'duplicate public tool name dropped');
    }
    log.info({
      tools: tools.length,
      upstreams: result.upstreams.map((u) => (u.stale ? `${u.upstream.slug}(stale)` : u.upstream.slug)),
      failed: result.failed.map((f) => f.upstream.slug),
      ms: Date.now() - started,
    }, 'tools/list');
    await audit('tools/list', started, { upstreamId: null, upstreamSlug: null, tool: null, outcome: 'ok', errorCode: null });
    return { tools };
  });

  return server;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated caller of /mcp (AUTH-08); attribution for audit (AUTH-11/13). */
    principal?: Principal;
  }
}

/** The JSON-RPC method of a request body, reduced to what the audit log records. */
function rpcMethod(body: unknown): AuditMethod {
  const m = (body as { method?: unknown } | null)?.method;
  return m === 'tools/call' || m === 'tools/list' || m === 'initialize' ? m : 'other';
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req.headers.authorization);
    // The raw socket address, not req.ip: X-Forwarded-For must not be able to claim loopback.
    const principal = token ? await deps.authenticate(token, { loopback: isLoopback(req.raw.socket.remoteAddress) }) : null;
    if (principal) {
      req.principal = principal;
      req.log = req.log.child({ userId: principal.userId, keyId: principal.keyId }); // every line of this request
      return;
    }
    req.log.warn({ ip: req.ip, hadToken: token !== '' }, 'rejected /mcp request: missing or invalid API key');
    // Audited without a user (nobody was authenticated) and without any client-supplied names.
    await deps.audit?.({ requestId: req.id, userId: null, apiKeyId: null, source: 'mcp', method: rpcMethod(req.body),
      upstreamId: null, upstreamSlug: null, tool: null, durationMs: reply.elapsedTime, outcome: 'denied', errorCode: 'invalid_api_key' });
    return reply.code(401).header('www-authenticate', 'Bearer')
      .send({ error: 'invalid_api_key', message: 'missing or invalid API key' });
  };

  app.post('/mcp', { preHandler: authenticate }, async (req, reply) => {
    const p = req.principal!;
    const server = buildServer(deps, req.log, { requestId: req.id, userId: p.userId, keyId: p.keyId, source: p.source ?? 'mcp' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.setHeader('x-request-id', req.id); // hijacked replies skip Fastify's headers
    reply.hijack(); // the SDK transport writes the raw response
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      req.log.error({ err: (e as Error).message }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  // Stateless: no server→client SSE stream (GET) and no sessions to end (DELETE).
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    preHandler: authenticate,
    handler: async (_req, reply) => reply.code(405).header('allow', 'POST')
      .send({ error: 'method_not_allowed', message: 'use POST (stateless Streamable HTTP)' }),
  });
}
