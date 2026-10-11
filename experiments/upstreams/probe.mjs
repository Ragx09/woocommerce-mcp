// ARC-15: gateway-side SDK client against third-party upstreams.
// Usage: node probe.mjs <url> [bearer-env-var]   e.g. node probe.mjs https://api.githubcopilot.com/mcp/ GITHUB_MCP_PAT
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, tokenVar] = process.argv.slice(2);
const headers = tokenVar ? { Authorization: `Bearer ${process.env[tokenVar] ?? ''}` } : {};
const connect = async () => {
  const client = new Client({ name: 'arc15-probe', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport, { timeout: 5000 });
  return { client, transport };
};
const t0 = Date.now();
const { client, transport } = await connect();
const { tools } = await client.listTools(undefined, { timeout: 5000 });
console.log(`connected in ${Date.now() - t0} ms, protocol ${transport.protocolVersion}, session ${transport.sessionId ? 'yes' : 'none'}`);
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
const bad = tools.filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)).map((t) => t.name);
console.log('names incompatible with our slug__tool scheme:', bad.length ? bad : 'none');
if (process.env.CALL) {
  const i = process.env.CALL.indexOf(' ');
  const [name, args] = i < 0 ? [process.env.CALL] : [process.env.CALL.slice(0, i), process.env.CALL.slice(i + 1)];
  const r = await client.callTool({ name, arguments: JSON.parse(args ?? '{}') }, undefined, { timeout: 15000 });
  console.log(`call ${name} -> isError=${!!r.isError} ${JSON.stringify(r.content).slice(0, 160)}`);
}
if (process.env.WAIT_RESTART) {
  console.log('waiting for upstream restart…');
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT_RESTART)));
  try { await client.listTools(undefined, { timeout: 5000 }); console.log('stale session: still works'); }
  catch (e) { console.log(`stale session: ${e.constructor.name} ${String(e.message).slice(0, 100)}`); }
  const fresh = await connect();
  console.log(`reconnect: ${(await fresh.client.listTools()).tools.length} tools`);
  await fresh.client.close();
}
await client.close();
