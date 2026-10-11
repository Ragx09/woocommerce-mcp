// ARC-13 experiment: SDK v1 stateless Streamable HTTP server behind a bearer check.
// Run: node server.mjs   (PORT=3999, TOKEN=test)
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 3999);
const TOKEN = Buffer.from(`Bearer ${process.env.TOKEN ?? 'test'}`);

function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  return got.length === TOKEN.length && timingSafeEqual(got, TOKEN);
}

// Stateless: a fresh server + transport per request, so any replica can answer any request.
function buildServer() {
  const server = new McpServer({ name: 'mcp-hello', version: '0.0.1' });
  server.registerTool(
    'greet',
    {
      description: 'Return a greeting for the given name',
      inputSchema: { name: z.string().min(1).max(50) },
    },
    async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }),
  );
  return server;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'invalid_api_key' }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString() || 'null'));
}).listen(PORT, () => console.log(`mcp-hello on http://localhost:${PORT}/mcp`));
