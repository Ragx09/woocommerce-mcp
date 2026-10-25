import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';
import { staticKeyAuth } from '../helpers/static-auth.js';

const DEV_KEY = 'k'.repeat(40);
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fake(opts?: Parameters<typeof startFakeUpstream>[0]): Promise<FakeUpstream> {
  const f = await startFakeUpstream(opts);
  cleanup.push(f.close);
  return f;
}
function row(over: Partial<Upstream> & { url: string }): Upstream {
  const now = new Date('2026-10-12T00:00:00Z');
  return { id: 'u1', slug: 'woo', name: 'Woo', enabled: true, authType: 'none', authHeader: null,
    credentialEnc: null, memberAccess: 'all', memberTools: [], storeId: null, hostedId: null, createdBy: null, createdAt: now, updatedAt: now, ...over };
}
/** A listening gateway whose upstream registry is `rows` (mutable between requests). */
async function gateway(rows: { current: Upstream[] | Error }, devKey: string | undefined = DEV_KEY) {
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  const pool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  registerMcp(app, {
    authenticate: staticKeyAuth(devKey),
    loadUpstreams: async () => { if (rows.current instanceof Error) throw rows.current; return rows.current; },
    pool,
    discovery: new ToolDiscovery(pool, { listTimeoutMs: 2_000 }), // not a timeout test: room for cold starts
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.unshift(async () => { await app.close(); await pool.close(); });
  const addr = app.server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/mcp`;
}
async function client(url: string, bearer = DEV_KEY): Promise<Client> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  cleanup.unshift(() => c.close());
  return c;
}

describe('gateway /mcp (GW-06)', () => {
  it('TC-GW-06-U1: aggregates tools of all enabled upstreams under public names', async () => {
    const a = await fake({ tools: ['echo', 'ping'] });
    const b = await fake({ tools: ['echo'] });
    const url = await gateway({ current: [row({ id: 'a', slug: 'woo', url: a.url }), row({ id: 'b', slug: 'everything', url: b.url })] });
    const c = await client(url);
    expect(c.getServerVersion()).toMatchObject({ name: 'mcp-gateway' });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['woo__echo', 'woo__ping', 'everything__echo']);
    expect(tools[0]).toMatchObject({ description: '[woo] fake echo', inputSchema: { type: 'object' } });
  });

  it('TC-GW-06-U2: missing or wrong key → 401; no key configured → everything refused', async () => {
    const url = await gateway({ current: [] });
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const auth of [undefined, 'Bearer wrong', DEV_KEY, `Basic ${DEV_KEY}`]) {
      const res = await fetch(url, { method: 'POST', headers: { ...headers, ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
      expect(res.status, String(auth)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'invalid_api_key', message: 'missing or invalid API key' });
    }
    // SEC-07: also on the hijacked (SDK-written) answers.
    const ok = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${DEV_KEY}` }, body: JSON.stringify(body) });
    expect(ok.status).toBe(200);
    expect([ok.headers.get('x-content-type-options'), ok.headers.get('cache-control')]).toEqual(['nosniff', 'no-store']);
    const closed = await gateway({ current: [] }, undefined);
    const res = await fetch(closed, { method: 'POST', headers: { ...headers, authorization: 'Bearer ' }, body: JSON.stringify(body) });
    expect(res.status).toBe(401);
  });

  it('TC-GW-06-U3: the client key is never forwarded upstream', async () => {
    const up = await fake();
    const url = await gateway({ current: [row({ url: up.url })] });
    await (await client(url)).listTools();
    expect(up.headers.length).toBeGreaterThan(0);
    for (const h of up.headers) {
      expect(h.authorization).toBeUndefined();
      expect(JSON.stringify(h)).not.toContain(DEV_KEY);
    }
  });

  it('TC-GW-06-U4: dead upstream left out, disabled upstream excluded, the rest still listed', async () => {
    const good = await fake({ tools: ['ok'] });
    const dead = await fake();
    const deadUrl = dead.url;
    await dead.close();
    const off = await fake({ tools: ['hidden'] });
    const url = await gateway({ current: [
      row({ id: 'g', slug: 'good', url: good.url }),
      row({ id: 'd', slug: 'dead', url: deadUrl }),
      row({ id: 'o', slug: 'off', url: off.url, enabled: false }),
    ] });
    const { tools } = await (await client(url)).listTools();
    expect(tools.map((t) => t.name)).toEqual(['good__ok']);
    expect(off.listCount()).toBe(0);
  });

  it('TC-GW-06-U5: registry changes are picked up on the next tools/list', async () => {
    const a = await fake({ tools: ['a'] });
    const rows = { current: [] as Upstream[] | Error };
    const c = await client(await gateway(rows));
    expect((await c.listTools()).tools).toEqual([]);
    rows.current = [row({ url: a.url })];
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['woo__a']);
  });

  it('TC-GW-06-U6: registry failure → JSON-RPC error without internals; GET → 405', async () => {
    const rows = { current: new Error('connect ECONNREFUSED postgres.platform.svc:5432 password=hunter2') as Upstream[] | Error };
    const url = await gateway(rows);
    const err = await (await client(url)).listTools().catch((e) => e);
    expect(String(err.message)).toContain('upstream registry unavailable');
    expect(String(err.message)).not.toMatch(/postgres|hunter2/);
    const res = await fetch(url, { headers: { authorization: `Bearer ${DEV_KEY}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe('gateway tools/call routing (GW-08)', () => {
  it('TC-GW-08-1: call is routed to the owning upstream with its arguments; result returned unchanged', async () => {
    const a = await fake({ tools: ['echo'] });
    const b = await fake({ tools: ['echo'] });
    const c = await client(await gateway({ current: [row({ id: 'a', slug: 'woo', url: a.url }), row({ id: 'b', slug: 'everything', url: b.url })] }));
    const r = await c.callTool({ name: 'everything__echo', arguments: { msg: 'hi' } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ tool: 'echo', args: { msg: 'hi' } });
    expect(b.callCount()).toBe(1);
    expect(a.callCount()).toBe(0);
  });

  it('TC-GW-08-2: unknown tool, unknown slug or malformed name → unknown_tool error, nothing forwarded', async () => {
    const up = await fake({ tools: ['echo'] });
    const c = await client(await gateway({ current: [row({ url: up.url })] }));
    for (const name of ['woo__nope', 'ghost__echo', 'echo', 'Woo__echo']) {
      const err = await c.callTool({ name, arguments: {} }).catch((e) => e);
      expect(err.code, name).toBe(-32602);
      expect(err.data, name).toEqual({ code: 'unknown_tool' });
    }
    expect(up.callCount()).toBe(0);
  });

  it('TC-GW-08-3: disabled upstream → upstream_disabled, nothing forwarded', async () => {
    const up = await fake({ tools: ['echo'] });
    const c = await client(await gateway({ current: [row({ url: up.url, enabled: false })] }));
    const err = await c.callTool({ name: 'woo__echo', arguments: {} }).catch((e) => e);
    expect(err.data).toEqual({ code: 'upstream_disabled' });
    expect(up.callCount()).toBe(0);
  });

  it('TC-GW-08-4: a shortened (hashed) public name routes to the full upstream tool name', async () => {
    const long = `${'x'.repeat(70)}_tool`;
    const up = await fake({ tools: [long] });
    const c = await client(await gateway({ current: [row({ slug: 'github', url: up.url })] }));
    const [t] = (await c.listTools()).tools;
    expect(t!.name).toHaveLength(64);
    const r = await c.callTool({ name: t!.name, arguments: {} });
    expect(JSON.parse(text(r)).tool).toBe(long);
  });

  it('TC-GW-08-5: upstream isError result passed through; JSON-RPC error → upstream_error, not retried', async () => {
    const up = await fake({ tools: ['fail', 'boom'] });
    const c = await client(await gateway({ current: [row({ url: up.url })] }));
    const r = await c.callTool({ name: 'woo__fail', arguments: { a: 1 } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r))).toEqual({ tool: 'fail', args: { a: 1 } });
    const b = await c.callTool({ name: 'woo__boom', arguments: {} });
    expect(b.isError).toBe(true);
    expect(text(b)).toBe('upstream_error: upstream woo failed: MCP error -32603');
    expect(up.callCount()).toBe(2); // one each: no retry
  });

  it('TC-GW-08-6: unreachable upstream → upstream_unreachable result quickly, no URL in the message', async () => {
    const up = await fake({ tools: ['echo'] });
    const rows = { current: [row({ url: up.url })] as Upstream[] | Error };
    const c = await client(await gateway(rows));
    await c.listTools(); // cached tool list, then the upstream dies
    await up.close();
    const t0 = Date.now();
    const r = await c.callTool({ name: 'woo__echo', arguments: {} });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^upstream_unreachable: upstream woo unreachable/);
    expect(text(r)).not.toContain('127.0.0.1');
  });

  it('TC-GW-08-7: the client key is not forwarded on calls', async () => {
    const up = await fake({ tools: ['echo'] });
    const c = await client(await gateway({ current: [row({ url: up.url })] }));
    await c.callTool({ name: 'woo__echo', arguments: {} });
    for (const h of up.headers) expect(JSON.stringify(h)).not.toContain(DEV_KEY);
  });
});
