// In-process MCP server for tests. `sessionful` mimics server-everything (issues Mcp-Session-Id);
// restart() forgets all sessions, like a pod restart. tools/list can be paginated (`pageSize`),
// slowed down (setListDelay) or made to fail (setListError) to exercise discovery (GW-05).
// tools/call echoes `{ tool, args }` as JSON text; tool `fail` returns isError, tool `boom` throws a
// JSON-RPC error, unknown tools return isError (like the SDK) (GW-08). Tool `slow` waits setCallDelay ms and
// records whether the gateway cancelled it (notifications/cancelled aborts the handler's signal) (GW-09).
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

export interface FakeUpstream {
  url: string;
  headers: IncomingHttpHeaders[];
  initializeCount: () => number;
  /** Number of tools/list requests received (one per page). */
  listCount: () => number;
  /** Number of tools/call requests received. */
  callCount: () => number;
  /** Number of `slow` calls the gateway cancelled (notifications/cancelled). */
  cancelledCount: () => number;
  setCallDelay: (ms: number) => void;
  setListDelay: (ms: number) => void;
  setListError: (on: boolean) => void;
  restart: () => void;
  close: () => Promise<void>;
}

export async function startFakeUpstream(
  opts: { sessionful?: boolean; tools?: string[]; pageSize?: number; port?: number } = {},
): Promise<FakeUpstream> {
  const tools = opts.tools ?? ['echo', 'ping'];
  const headers: IncomingHttpHeaders[] = [];
  let inits = 0;
  let lists = 0;
  let calls = 0;
  let listDelayMs = 0;
  let callDelayMs = 0;
  let cancelled = 0;
  let listError = false;
  let sessions = new Map<string, StreamableHTTPServerTransport>();

  const build = () => {
    const mcp = new McpServer({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    for (const t of tools) mcp.registerTool(t, { description: `fake ${t}` }, async () => ({ content: [{ type: 'text', text: t }] }));
    // Replace the SDK's tools/list handler: same tools, plus paging, delay and failure injection.
    const size = opts.pageSize ?? tools.length;
    mcp.server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      lists++;
      if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs));
      if (listError) throw new McpError(-32603, 'list failed');
      const start = Number(req.params?.cursor ?? 0);
      const page = tools.slice(start, start + size).map((name) => ({
        name, description: `fake ${name}`, inputSchema: { type: 'object' as const, properties: {} },
      }));
      return start + size < tools.length ? { tools: page, nextCursor: String(start + size) } : { tools: page };
    });
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      calls++;
      const { name, arguments: args } = req.params;
      if (!tools.includes(name)) return { isError: true, content: [{ type: 'text' as const, text: `Tool ${name} not found` }] };
      if (name === 'boom') throw new McpError(-32603, 'boom failed');
      if (name === 'slow') {
        await new Promise<void>((r) => {
          const t = setTimeout(r, callDelayMs);
          extra.signal.addEventListener('abort', () => { cancelled++; clearTimeout(t); r(); }, { once: true });
        });
      }
      const text = JSON.stringify({ tool: name, args: args ?? {} });
      return name === 'fail' ? { isError: true, content: [{ type: 'text' as const, text }] } : { content: [{ type: 'text' as const, text }] };
    });
    return mcp;
  };

  const http: Server = createServer(async (req, res) => {
    headers.push(req.headers);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (body?.method === 'initialize') inits++;
    if (!opts.sessionful) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); });
      await build().connect(transport);
      return transport.handleRequest(req, res, body);
    }
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (body?.method !== 'initialize') {
        res.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, t); },
      });
      transport = t;
      await build().connect(transport);
    }
    return transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => http.listen(opts.port ?? 0, '127.0.0.1', r)); // fixed port: restart on the same URL
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    initializeCount: () => inits,
    listCount: () => lists,
    callCount: () => calls,
    cancelledCount: () => cancelled,
    setCallDelay: (ms) => { callDelayMs = ms; },
    setListDelay: (ms) => { listDelayMs = ms; },
    setListError: (on) => { listError = on; },
    restart: () => { sessions = new Map(); },
    close: () => new Promise((r) => { http.closeAllConnections(); http.close(() => r()); }),
  };
}

/** A TCP server that accepts connections and never answers: models a hung upstream (GW-09). */
export async function startBlackhole(): Promise<{ url: string; close: () => Promise<void> }> {
  const http = createServer(() => { /* never respond */ });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((r) => { http.closeAllConnections(); http.close(() => r()); }),
  };
}
