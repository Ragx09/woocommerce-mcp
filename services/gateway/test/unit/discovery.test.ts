import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { ToolDiscovery, type DiscoveryOptions } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

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
    credentialEnc: null, createdBy: null, createdAt: now, updatedAt: now, ...over };
}
/** A pool synced with `rows` and a discovery on top, with a controllable clock. */
async function setup(rows: Upstream[], opts: DiscoveryOptions = {}) {
  const pool = new UpstreamPool({ key, connectTimeoutMs: 500 });
  cleanup.unshift(() => pool.close()); // close the pool before the fake servers
  await pool.sync(rows);
  const clock = { t: 1_000_000 };
  const d = new ToolDiscovery(pool, { listTimeoutMs: 300, maxStaleMs: 60_000, now: () => clock.t, ...opts });
  return { pool, d, clock };
}
const names = (r: { tools: { name: string }[] }) => r.tools.map((t) => t.name);

describe('ToolDiscovery (GW-05)', () => {
  it('TC-GW-05-1: lists every page of tools and records when', async () => {
    const up = await fake({ tools: ['a', 'b', 'c', 'd', 'e'], pageSize: 2 });
    // Generous budget: this is the file's first (cold) request and is not about timeouts.
    const { d, clock } = await setup([row({ url: up.url })], { listTimeoutMs: 3_000 });
    const r = await d.discover();
    expect(r.failed).toEqual([]);
    expect(r.upstreams).toHaveLength(1);
    expect(names(r.upstreams[0]!)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.upstreams[0]).toMatchObject({ stale: false, fetchedAt: clock.t });
    expect(r.upstreams[0]!.tools[0]).toMatchObject({ description: 'fake a', inputSchema: { type: 'object' } });
    expect(up.listCount()).toBe(3);
  });

  it('TC-GW-05-2: slow upstream → cached list served (stale) within the budget; others unaffected', async () => {
    const slow = await fake({ tools: ['s1'] });
    const fast = await fake({ tools: ['f1'] });
    const { d, clock } = await setup([row({ id: 's', slug: 'slow', url: slow.url }), row({ id: 'f', slug: 'fast', url: fast.url })]);
    await d.discover();
    const firstFetch = clock.t;
    clock.t += 30_000;
    slow.setListDelay(2_000);
    const t0 = Date.now();
    const r = await d.discover();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.failed).toEqual([]);
    const [s, f] = r.upstreams;
    expect(names(s!)).toEqual(['s1']);
    expect(s).toMatchObject({ stale: true, fetchedAt: firstFetch, error: 'upstream slow timed out after 300 ms' });
    expect(names(f!)).toEqual(['f1']);
    expect(f).toMatchObject({ stale: false, fetchedAt: clock.t });
  });

  it('TC-GW-05-3: cache older than maxStale → upstream omitted and reported', async () => {
    const up = await fake();
    const { d, clock } = await setup([row({ url: up.url })]);
    await d.discover();
    clock.t += 60_001;
    up.setListError(true);
    const r = await d.discover();
    expect(r.upstreams).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.error).toBe('upstream woo failed to list tools: MCP error -32603');
  });

  it('TC-GW-05-4: failing upstream without cache is isolated; the healthy one is still listed', async () => {
    const bad = await fake();
    bad.setListError(true);
    const good = await fake({ tools: ['g'] });
    const { d } = await setup([row({ id: 'b', slug: 'bad', url: bad.url }), row({ id: 'g', slug: 'good', url: good.url })]);
    const r = await d.discover();
    expect(r.upstreams.map((u) => u.upstream.slug)).toEqual(['good']);
    expect(r.failed.map((f) => f.upstream.slug)).toEqual(['bad']);
  });

  it('TC-GW-05-5: unreachable upstream → failed quickly, message without the URL', async () => {
    const up = await fake();
    const url = up.url;
    await up.close();
    const { d } = await setup([row({ url })]);
    const t0 = Date.now();
    const r = await d.discover();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.failed[0]!.error).toMatch(/^upstream woo (unreachable|timed out)/);
    expect(r.failed[0]!.error).not.toContain('127.0.0.1');
  });

  it('TC-GW-05-6: a config change invalidates the cached list', async () => {
    const a = await fake({ tools: ['a'] });
    const b = await fake({ tools: ['b'] });
    const { pool, d } = await setup([row({ url: a.url })]);
    expect(names((await d.discover()).upstreams[0]!)).toEqual(['a']);
    b.setListError(true);
    await pool.sync([row({ url: b.url, updatedAt: new Date('2026-10-12T01:00:00Z') })]);
    const r = await d.discover();
    expect(r.upstreams).toEqual([]); // not the old server's tools
    expect(r.failed.map((f) => f.upstream.slug)).toEqual(['woo']);
  });

  it('TC-GW-05-7: concurrent discover() calls share one upstream request; disabled upstream drops out', async () => {
    const up = await fake();
    const { pool, d } = await setup([row({ url: up.url })]);
    up.setListDelay(100);
    const results = await Promise.all([d.discover(), d.discover(), d.discover()]);
    expect(results.map((r) => names(r.upstreams[0]!))).toEqual([['echo', 'ping'], ['echo', 'ping'], ['echo', 'ping']]);
    expect(up.listCount()).toBe(1);
    await pool.sync([row({ url: up.url, enabled: false })]);
    expect(await d.discover()).toEqual({ upstreams: [], failed: [] });
  });
});

describe('ToolDiscovery.toolsFor (GW-08)', () => {
  it('TC-GW-08-8: serves the fresh cache without an upstream request; refreshes when stale or changed', async () => {
    const up = await fake({ tools: ['a'] });
    const r = row({ url: up.url });
    const { d, clock } = await setup([r]);
    await d.discover();
    expect(up.listCount()).toBe(1);
    expect((await d.toolsFor(r)).map((t) => t.name)).toEqual(['a']);
    expect(up.listCount()).toBe(1); // cache hit
    clock.t += 60_001;
    await d.toolsFor(r);
    expect(up.listCount()).toBe(2); // too old → refreshed
    await d.toolsFor({ ...r, updatedAt: new Date('2026-10-12T02:00:00Z') });
    expect(up.listCount()).toBe(3); // config changed → refreshed
  });
});
