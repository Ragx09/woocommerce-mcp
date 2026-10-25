// HTTP layer: auth, health endpoints and a full Streamable HTTP round trip with the SDK client.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Config } from '../../src/config.js';
import { loadConfig } from '../../src/config.js';
import { createHttpServer } from '../../src/server.js';
import { WooClient } from '../../src/woo-client.js';

const cfg: Config = {
  port: 0, wooBaseUrl: 'http://wp.invalid', wooSigningUrl: 'http://wp.invalid', wooConsumerKey: 'ck', wooConsumerSecret: 'cs',
  wooTimeoutMs: 200, mcpAuthToken: 'gateway-token', logLevel: 'silent',
};
let storeUp = true;
const fakeFetch = (async () => (storeUp ? new Response('[]', { status: 200 }) : new Response('{}', { status: 502 }))) as typeof fetch;
const server = createHttpServer(cfg, pino({ level: 'silent' }), new WooClient(cfg, fakeFetch));
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
const post = (headers: Record<string, string>) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: initBody });

describe('woo-mcp HTTP server', () => {
  it('TC-WC-06-1 /healthz → 200', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok' });
  });

  it('/readyz follows store reachability', async () => {
    storeUp = true;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('rejects /mcp without the gateway token (401) or with a wrong one', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post({ authorization: 'gateway-token' })).status).toBe(401);
  });

  it('GET /mcp → 405 (stateless: no SSE stream)', async () => {
    const r = await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer gateway-token' } });
    expect(r.status).toBe(405);
  });

  it('SDK client lists the six tools over Streamable HTTP with no session id', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer gateway-token' } } });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    expect(transport.sessionId).toBeUndefined();
    expect((await client.listTools()).tools).toHaveLength(6);
    await client.close();
  });

  it('rejects oversized bodies (413)', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1) });
    expect(r.status).toBe(413);
  });
});

describe('config', () => {
  const env = { WOO_BASE_URL: 'http://wordpress.store.svc/', WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs', MCP_AUTH_TOKEN: 't' };
  it('requires credentials and the gateway token', () => {
    expect(() => loadConfig({ ...env, WOO_CONSUMER_SECRET: '' })).toThrow(/WOO_CONSUMER_SECRET/);
    expect(() => loadConfig({ ...env, MCP_AUTH_TOKEN: '' })).toThrow(/MCP_AUTH_TOKEN/);
  });
  it('defaults the signing URL to the base URL and strips trailing slashes', () => {
    expect(loadConfig(env)).toMatchObject({ wooBaseUrl: 'http://wordpress.store.svc', wooSigningUrl: 'http://wordpress.store.svc' });
  });
  it('rejects non-http URLs', () => expect(() => loadConfig({ ...env, WOO_BASE_URL: 'file:///etc/passwd' })).toThrow(/http/));
});
