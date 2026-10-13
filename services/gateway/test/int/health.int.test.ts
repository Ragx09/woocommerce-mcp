// TC-INT-04 (GW-10): a dead upstream is marked Unreachable and does not slow down or break the others;
// it comes back as Connected once it answers again. In-process fake upstreams; no database needed.
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
import { HealthMonitor } from '../../src/upstreams/health.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { startBlackhole, startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';
import { staticKeyAuth } from '../helpers/static-auth.js';

const DEV_KEY = 'k'.repeat(40);
const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function row(id: string, slug: string, url: string, enabled = true): Upstream {
  const now = new Date('2026-10-13T00:00:00Z');
  return { id, slug, name: slug, url, enabled, authType: 'none', authHeader: null,
    credentialEnc: null, createdBy: null, createdAt: now, updatedAt: now };
}

async function fake(opts?: Parameters<typeof startFakeUpstream>[0]): Promise<FakeUpstream> {
  const f = await startFakeUpstream(opts);
  cleanup.push(f.close);
  return f;
}
const portOf = (url: string) => Number(new URL(url).port);

/** Gateway + health monitor over `rows` (mutable). The loop is not started unless `intervalMs` is given. */
async function setup(rows: { current: Upstream[] }, intervalMs?: number) {
  const app = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
  const pool = new UpstreamPool({ key, connectTimeoutMs: 300 });
  const loadUpstreams = async () => rows.current;
  const health = new HealthMonitor(pool, { loadUpstreams, intervalMs, checkTimeoutMs: 1_000 });
  registerMcp(app, {
    authenticate: staticKeyAuth(DEV_KEY), loadUpstreams, pool, health, callTimeoutMs: 2_000,
    discovery: new ToolDiscovery(pool, { listTimeoutMs: 1_000, health }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  if (intervalMs) health.start();
  cleanup.push(async () => { await health.stop(); await app.close(); await pool.close(); });
  const { port } = app.server.address() as { port: number };
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${DEV_KEY}` } } }));
  cleanup.unshift(() => c.close());
  return { c, health };
}

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

describe('TC-INT-04 health and failure isolation (GW-10)', () => {
  it('dead upstream → Unreachable with last error; others listed and callable; fails fast; recovers', async () => {
    const woo = await fake({ tools: ['echo'] });
    const ev = await fake({ tools: ['echo'], sessionful: true });
    const rows = { current: [row('w', 'woo', woo.url), row('e', 'everything', ev.url)] };
    const { c, health } = await setup(rows);

    await health.checkAll();
    expect(health.get(rows.current[1]!)).toMatchObject({ status: 'connected', lastError: null });
    expect(await names(c)).toEqual(['woo__echo', 'everything__echo']);

    await ev.close(); // the pod dies
    await health.checkAll();
    const dead = health.get(rows.current[1]!);
    expect(dead.status).toBe('unreachable');
    expect(dead.lastError).toMatch(/^upstream everything unreachable: /);
    expect(dead.lastError).not.toContain('127.0.0.1');
    expect(dead.lastCheckedAt).toBeInstanceOf(Date);
    expect(health.get(rows.current[0]!).status).toBe('connected');

    // Others unaffected; the dead one is not even contacted (fast).
    let t0 = Date.now();
    expect(await names(c)).toEqual(['woo__echo']);
    expect(Date.now() - t0).toBeLessThan(200);
    expect((await c.callTool({ name: 'woo__echo', arguments: {} })).isError).toBeFalsy();
    t0 = Date.now();
    const r = await c.callTool({ name: 'everything__echo', arguments: {} });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(text(r)).toMatch(/^upstream_unreachable: upstream everything unreachable: /);

    // Back on the same address → Connected on the next check, tools return.
    await fake({ tools: ['echo'], sessionful: true, port: portOf(ev.url) });
    await health.checkAll();
    expect(health.get(rows.current[1]!)).toMatchObject({ status: 'connected' });
    expect(health.get(rows.current[1]!).lastError).toMatch(/unreachable/); // last problem kept for the dashboard
    expect(await names(c)).toEqual(['woo__echo', 'everything__echo']);
    expect((await c.callTool({ name: 'everything__echo', arguments: {} })).isError).toBeFalsy();
  });

  it('hung upstream → Unreachable after one check budget; later lists skip it without waiting', async () => {
    const woo = await fake({ tools: ['echo'] });
    const hole = await startBlackhole();
    cleanup.push(hole.close);
    const rows = { current: [row('w', 'woo', woo.url), row('g', 'github', hole.url)] };
    const { c, health } = await setup(rows);
    const t0 = Date.now();
    await health.checkAll();
    expect(Date.now() - t0).toBeLessThan(1_500); // one check budget (1 s)
    expect(health.get(rows.current[1]!)).toMatchObject({ status: 'unreachable' });
    const t1 = Date.now();
    expect(await names(c)).toEqual(['woo__echo']);
    expect(Date.now() - t1).toBeLessThan(200);
  });

  it('disabled upstream → status Disabled and never contacted', async () => {
    const off = await fake({ tools: ['echo'] });
    const rows = { current: [row('o', 'off', off.url, false)] };
    const { health } = await setup(rows);
    await health.checkAll();
    expect(health.get(rows.current[0]!).status).toBe('disabled');
    expect(off.headers).toHaveLength(0);
  });

  it('a refused connection during a call marks the upstream Unreachable at once (no wait for the loop)', async () => {
    const ev = await fake({ tools: ['echo'] });
    const rows = { current: [row('e', 'everything', ev.url)] };
    const { c, health } = await setup(rows);
    await c.listTools();
    expect(health.get(rows.current[0]!).status).toBe('connected'); // reported by the list
    await ev.close();
    const r = await c.callTool({ name: 'everything__echo', arguments: {} });
    expect(text(r)).toMatch(/^upstream_unreachable: /);
    expect(health.get(rows.current[0]!).status).toBe('unreachable');
  });

  it('the loop notices death and recovery by itself', async () => {
    const ev = await fake({ tools: ['echo'] });
    const rows = { current: [row('e', 'everything', ev.url)] };
    const { health } = await setup(rows, 100);
    await expect.poll(() => health.get(rows.current[0]!).status).toBe('connected');
    await ev.close();
    await expect.poll(() => health.get(rows.current[0]!).status).toBe('unreachable');
    await fake({ tools: ['echo'], port: portOf(ev.url) });
    await expect.poll(() => health.get(rows.current[0]!).status).toBe('connected');
  });
});
