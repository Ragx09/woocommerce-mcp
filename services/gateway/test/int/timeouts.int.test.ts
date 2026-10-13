// TC-INT-03 (GW-09): slow and hung upstreams hit their budgets and get a clear error; others are unaffected.
// Runs against in-process fake upstreams through a real listening gateway; no database needed.
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { startBlackhole, startFakeUpstream } from '../helpers/fake-upstream.js';
import { staticKeyAuth } from '../helpers/static-auth.js';

const DEV_KEY = 'k'.repeat(40);
const T = { connectMs: 300, listMs: 400, callMs: 600 };
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function row(id: string, slug: string, url: string): Upstream {
  const now = new Date('2026-10-13T00:00:00Z');
  return { id, slug, name: slug, url, enabled: true, authType: 'none', authHeader: null,
    credentialEnc: null, createdBy: null, createdAt: now, updatedAt: now };
}

async function gatewayClient(rows: Upstream[]): Promise<Client> {
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  const pool = new UpstreamPool({ key, connectTimeoutMs: T.connectMs });
  registerMcp(app, {
    authenticate: staticKeyAuth(DEV_KEY), loadUpstreams: async () => rows, pool,
    discovery: new ToolDiscovery(pool, { listTimeoutMs: T.listMs }), callTimeoutMs: T.callMs,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanup.push(async () => { await app.close(); await pool.close(); });
  const { port } = app.server.address() as { port: number };
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${DEV_KEY}` } } }));
  cleanup.unshift(() => c.close());
  return c;
}

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const timed = async <R>(fn: () => Promise<R>) => { const t0 = Date.now(); const r = await fn(); return { r, ms: Date.now() - t0 }; };

describe('TC-INT-03 timeouts (GW-09)', () => {
  it('slow call → upstream_timeout within the budget, upstream told to cancel, no retry; others unaffected', async () => {
    const slow = await startFakeUpstream({ tools: ['slow', 'echo'], sessionful: true }); // like server-everything
    const fast = await startFakeUpstream({ tools: ['echo'] });
    cleanup.push(slow.close, fast.close);
    slow.setCallDelay(5_000);
    const c = await gatewayClient([row('a', 'everything', slow.url), row('b', 'woo', fast.url)]);
    await c.listTools();

    const [s, f] = await Promise.all([
      timed(() => c.callTool({ name: 'everything__slow', arguments: {} })),
      timed(() => c.callTool({ name: 'woo__echo', arguments: {} })),
    ]);
    expect(s.r.isError).toBe(true);
    expect(text(s.r)).toBe('upstream_timeout: upstream everything did not answer within 0.6 s');
    expect(s.ms).toBeGreaterThanOrEqual(T.callMs - 50);
    expect(s.ms).toBeLessThan(T.callMs + 500);
    expect(f.r.isError).toBeFalsy();
    expect(f.ms).toBeLessThan(T.callMs);
    // notifications/cancelled reached the upstream. Only a sessionful upstream can act on it: a stateless
    // one (woo-mcp) gets the cancel on a fresh server instance, so there only the HTTP request is aborted.
    await expect.poll(() => slow.cancelledCount()).toBe(1);
    expect(slow.callCount()).toBe(1); // a timed-out call is never repeated (it may have run)

    // The same upstream still serves fast calls afterwards.
    expect((await c.callTool({ name: 'everything__echo', arguments: {} })).isError).toBeFalsy();
  });

  it('slow tools/list → that upstream left out within the list budget, the others listed', async () => {
    const slow = await startFakeUpstream({ tools: ['echo'] });
    const fast = await startFakeUpstream({ tools: ['echo'] });
    cleanup.push(slow.close, fast.close);
    slow.setListDelay(5_000);
    const c = await gatewayClient([row('a', 'everything', slow.url), row('b', 'woo', fast.url)]);
    const { r, ms } = await timed(() => c.listTools());
    expect(r.tools.map((t) => t.name)).toEqual(['woo__echo']);
    expect(ms).toBeLessThan(T.listMs + 500);
  });

  it('hung upstream (accepts TCP, never answers) → list and call return within budget', async () => {
    const hole = await startBlackhole();
    const fast = await startFakeUpstream({ tools: ['echo'] });
    cleanup.push(hole.close, fast.close);
    const c = await gatewayClient([row('a', 'github', hole.url), row('b', 'woo', fast.url)]);
    const list = await timed(() => c.listTools());
    expect(list.r.tools.map((t) => t.name)).toEqual(['woo__echo']);
    expect(list.ms).toBeLessThan(T.listMs + 500);

    // No tool list for github → the lookup itself times out; the error is readable and has no URL.
    const call = await timed(() => c.callTool({ name: 'github__anything', arguments: {} }));
    expect(call.r.isError).toBe(true);
    expect(text(call.r)).toMatch(/^upstream_(timeout|unreachable): upstream github /);
    expect(text(call.r)).not.toContain('127.0.0.1');
    expect(call.ms).toBeLessThan(T.callMs + 500);
  });
});
