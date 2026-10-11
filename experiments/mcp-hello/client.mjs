// ARC-13: the gateway side — SDK v1 Client over Streamable HTTP with an injected bearer header.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.URL ?? 'http://localhost:3999/mcp');
const client = new Client({ name: 'arc13-client', version: '0.0.1' });
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${process.env.TOKEN ?? 'test'}` } },
});
await client.connect(transport);
console.log('protocol:', transport.protocolVersion, 'server:', client.getServerVersion()?.name, 'session:', transport.sessionId ?? '(none — stateless)');
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const r = await client.callTool({ name: 'greet', arguments: { name: 'gateway' } });
console.log('call greet ->', r.content[0].text, 'isError:', !!r.isError);
const bad = await client.callTool({ name: 'greet', arguments: { name: '' } });
console.log('call greet with invalid args -> isError:', !!bad.isError);
await client.close();
