// HTTP layer: POST /mcp (stateless Streamable HTTP), GET /healthz (liveness), GET /readyz (store reachable).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { registerTools } from './tools.js';
import { WooClient } from './woo-client.js';

const MAX_BODY = 1024 * 1024;
export const VERSION = '0.1.0';

const digest = (s: string) => createHash('sha256').update(s).digest();
function bearerOk(header: string | undefined, token: string): boolean {
  if (!token) return true; // explicitly disabled via MCP_AUTH_DISABLED
  const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(got), digest(token)); // equal-length digests: constant time, no length leak
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : undefined; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

export function buildMcpServer(woo: WooClient): McpServer {
  const server = new McpServer({ name: 'woo-mcp', version: VERSION }, { capabilities: { tools: {} } });
  registerTools(server, woo);
  return server;
}

export function createHttpServer(cfg: Config, log: Logger, woo = new WooClient(cfg)): Server {
  let ready: { ok: boolean; at: number } = { ok: false, at: 0 };

  async function checkReady(): Promise<boolean> {
    if (Date.now() - ready.at < 5_000) return ready.ok;
    try {
      // Signed call: proves reachability *and* that our REST credentials are accepted.
      await woo.request('GET', '/products', { query: { per_page: 1, _fields: 'id' } });
      ready = { ok: true, at: Date.now() };
    } catch (e) {
      if (ready.ok || !ready.at) log.warn({ err: (e as Error).message }, 'store not ready');
      ready = { ok: false, at: Date.now() };
    }
    return ready.ok;
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok', version: VERSION });
    if (req.method === 'GET' && path === '/readyz') {
      const okNow = await checkReady();
      return json(res, okNow ? 200 : 503, { status: okNow ? 'ready' : 'store_unavailable' });
    }
    if (path !== '/mcp') return json(res, 404, { error: 'not_found' });
    if (!bearerOk(req.headers.authorization, cfg.mcpAuthToken)) {
      log.warn({ remote: req.socket.remoteAddress }, 'rejected /mcp request without valid token');
      return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }
    // Stateless server: no sessions, so GET (SSE stream) and DELETE (session end) are not supported.
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

    const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();
    const started = Date.now();
    let body: unknown;
    try { body = await readBody(req); }
    catch (e) { return json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message }); }

    const server = buildMcpServer(woo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log.error({ requestId, err: (e as Error).message }, 'mcp request failed');
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
    const msg = body as { method?: string; params?: { name?: string } } | undefined;
    log.info({ requestId, method: msg?.method, tool: msg?.params?.name, ms: Date.now() - started, status: res.statusCode }, 'mcp');
  });
}
