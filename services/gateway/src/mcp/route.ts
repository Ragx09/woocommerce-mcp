// GW-06: the gateway's own MCP endpoint, POST /mcp (stateless Streamable HTTP, D-002).
// - tools/list: reload enabled upstreams from the DB (so every replica agrees), discover their tools
//   (GW-05), and return them under public names (GW-07).
// - Auth: TEMPORARY static dev key (MCP_DEV_KEY) until AUTH-08 replaces it with per-user API keys.
//   Without a configured key every request is refused (fail closed). The inbound Authorization header
//   is only checked here; it is never forwarded upstream (T-04).
import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { VERSION } from '../app.js';
import type { Upstream } from '../db/schema.js';
import type { ToolDiscovery } from '../upstreams/discovery.js';
import type { UpstreamPool } from '../upstreams/pool.js';
import { aggregateTools } from './aggregate.js';

export interface McpDeps {
  /** Temporary shared key (AUTH-08 removes it). Undefined → /mcp refuses everything. */
  devKey: string | undefined;
  loadUpstreams: () => Promise<Upstream[]>;
  pool: UpstreamPool;
  discovery: ToolDiscovery;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

function keyOk(header: string | undefined, key: string | undefined): boolean {
  if (!key) return false;
  const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(got), digest(key)); // equal-length digests: constant time
}

function buildServer(deps: McpDeps, log: FastifyBaseLogger): Server {
  const server = new Server({ name: 'mcp-gateway', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const started = Date.now();
    let rows: Upstream[];
    try {
      rows = await deps.loadUpstreams();
    } catch (e) {
      log.error({ err: (e as Error).message }, 'tools/list: loading upstreams failed');
      throw new McpError(ErrorCode.InternalError, 'upstream registry unavailable'); // no DB details to clients
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
