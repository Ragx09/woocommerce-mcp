// In-process MCP server for tests. `sessionful` mimics server-everything (issues Mcp-Session-Id);
// restart() forgets all sessions, like a pod restart.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface FakeUpstream {
  url: string;
  headers: IncomingHttpHeaders[];
  initializeCount: () => number;
  restart: () => void;
  close: () => Promise<void>;
}

export async function startFakeUpstream(opts: { sessionful?: boolean; tools?: string[] } = {}): Promise<FakeUpstream> {
  const tools = opts.tools ?? ['echo', 'ping'];
  const headers: IncomingHttpHeaders[] = [];
  let inits = 0;
  let sessions = new Map<string, StreamableHTTPServerTransport>();

  const build = () => {
    const mcp = new McpServer({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    for (const t of tools) mcp.registerTool(t, { description: `fake ${t}` }, async () => ({ content: [{ type: 'text', text: t }] }));
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
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    initializeCount: () => inits,
    restart: () => { sessions = new Map(); },
    close: () => new Promise((r) => { http.closeAllConnections(); http.close(() => r()); }),
  };
}
