// GW-06: the gateway's own MCP endpoint, POST /mcp (stateless Streamable HTTP, D-002).
// - tools/list: reload enabled upstreams from the DB (so every replica agrees), discover their tools
//   (GW-05), and return them under public names (GW-07).
// - tools/call (GW-08): public name → upstream + tool (via ToolIndex, so shortened names work) →
//   forward → the upstream result unchanged. Unknown/disabled → JSON-RPC error; problems reaching
//   the upstream → an isError result the model can read. Arguments and results are never logged.
// - Auth: TEMPORARY static dev key (MCP_DEV_KEY) until AUTH-08 replaces it with per-user API keys.
//   Without a configured key every request is refused (fail closed). The inbound Authorization header
//   is only checked here; it is never forwarded upstream (T-04).
import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { VERSION } from '../app.js';
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
  /** Temporary shared key (AUTH-08 removes it). Undefined → /mcp refuses everything. */
  devKey: string | undefined;
  loadUpstreams: () => Promise<Upstream[]>;
  pool: UpstreamPool;
  discovery: ToolDiscovery;
  /** GW-10: unreachable upstreams fail fast; call outcomes are reported back. */
  health?: HealthMonitor;
  /** Budget for one forwarded tools/call, including connecting and a reconnect (GW-09). */
  callTimeoutMs?: number;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

function keyOk(header: string | undefined, key: string | undefined): boolean {
  if (!key) return false;
  const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(got), digest(key)); // equal-length digests: constant time
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
function callFailure(slug: string, e: unknown, budgetMs: number): { outcome: string; result: CallToolResult } {
  if (e instanceof UpstreamUnavailableError) return { outcome: 'unreachable', result: errorResult('upstream_unreachable', e.message) };
  if (e instanceof UpstreamTimeoutError || (e instanceof McpError && e.code === ErrorCode.RequestTimeout)) {
    const ms = e instanceof UpstreamTimeoutError ? e.ms : budgetMs;
    return { outcome: 'timeout', result: errorResult('upstream_timeout', `upstream ${slug} did not answer within ${ms / 1000} s`) };
  }
  return { outcome: 'error', result: errorResult('upstream_error', `upstream ${slug} failed: ${safeReason(e)}`) };
}

function buildServer(deps: McpDeps, log: FastifyBaseLogger): Server {
  const server = new Server({ name: 'mcp-gateway', version: VERSION }, { capabilities: { tools: {} } });
  const callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    const publicName = req.params.name;
    const parsed = parsePublicName(publicName);
    if (!parsed) throw unknownTool(publicName);
    const rows = await loadRows(deps, log, 'tools/call');
    const row = rows.find((r) => r.slug === parsed.slug);
    if (!row) throw unknownTool(publicName);
    if (!row.enabled) {
      throw new McpError(ErrorCode.InvalidParams, `upstream ${row.slug} is disabled`, { code: 'upstream_disabled' });
    }
    await deps.pool.sync(rows);

    // Never the argument values or the result (they can hold personal data or secrets); at debug level
    // the argument names help to debug a failing call (GW-17).
    log.debug({ upstream: row.slug, tool: publicName, argNames: Object.keys(req.params.arguments ?? {}) }, 'tools/call arguments');
    const done = (outcome: string, tool?: string) =>
      log.info({ upstream: row.slug, tool: tool ?? publicName, outcome, ms: Date.now() - started }, 'tools/call');
    if (deps.health?.isUnreachable(row.id)) {
      // Fail fast: the health loop brings it back within one interval once it answers again.
      done('unreachable');
      return errorResult('upstream_unreachable', deps.health.get(row).lastError ?? `upstream ${row.slug} unreachable`);
    }
    let tool: string | undefined;
    try {
      const index = new ToolIndex();
      for (const t of await deps.discovery.toolsFor(row)) if (t.name) index.add(row.id, row.slug, t.name);
      tool = index.resolve(publicName)?.tool;
    } catch (e) {
      const f = callFailure(row.slug, e, callTimeoutMs);
      done(f.outcome);
      return f.result;
    }
    if (!tool) throw unknownTool(publicName);

    try {
      // One deadline for connect + call (+ the reconnect, when that is safe): the client never waits longer.
      const result = await withDeadline(row.slug, callTimeoutMs, (signal) => deps.pool.withClient(
        row.id,
        (c) => c.callTool({ name: tool, arguments: req.params.arguments }, undefined, { signal, timeout: callTimeoutMs }),
        isSafeCallRetry,
      ));
      done(result.isError ? 'tool_error' : 'ok', tool);
      deps.health?.reportOk(row);
      return result;
    } catch (e) {
      // A slow tool says nothing about health; only "could not connect" marks the upstream unreachable.
      if (e instanceof UpstreamUnavailableError) deps.health?.reportFailure(row, e);
      const f = callFailure(row.slug, e, callTimeoutMs);
      done(f.outcome, tool);
      return f.result;
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const started = Date.now();
    const rows = await loadRows(deps, log, 'tools/list');
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
    return { tools };
  });

  return server;
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (keyOk(req.headers.authorization, deps.devKey)) return;
    req.log.warn({ ip: req.ip }, 'rejected /mcp request: missing or invalid API key');
    return reply.code(401).header('www-authenticate', 'Bearer')
      .send({ error: 'invalid_api_key', message: 'missing or invalid API key' });
  };

  app.post('/mcp', { preHandler: authenticate }, async (req, reply) => {
    const server = buildServer(deps, req.log);
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
