import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { capResponse, ResponseTooLargeError, safeReason, UpstreamPool, UpstreamUnavailableError } from '../../src/upstreams/pool.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fake(opts?: Parameters<typeof startFakeUpstream>[0]): Promise<FakeUpstream> {
  const f = await startFakeUpstream(opts);
  cleanup.push(f.close);
  return f;
}
function pool(maxResponseBytes?: number): UpstreamPool {
  const p = new UpstreamPool({ key, connectTimeoutMs: 1_000, maxResponseBytes });
  cleanup.unshift(() => p.close()); // close the pool before the fake servers
  return p;
}
function row(over: Partial<Upstream> & { url: string }): Upstream {
  const now = new Date('2026-10-12T00:00:00Z');
  return { id: 'u1', slug: 'woo', name: 'Woo', enabled: true, authType: 'none', authHeader: null,
    credentialEnc: null, createdBy: null, createdAt: now, updatedAt: now, ...over };
}
const toolNames = (p: UpstreamPool, id = 'u1') => p.withClient(id, async (c) => (await c.listTools()).tools.map((t) => t.name));

describe('UpstreamPool (GW-04)', () => {
  it('TC-GW-04-1: connect, list tools, reuse the connection, close', async () => {
    const up = await fake();
    const p = pool();
    await p.sync([row({ url: up.url })]);
    expect(p.isConnected('u1')).toBe(false); // lazy
    expect(await toolNames(p)).toEqual(['echo', 'ping']);
    expect(await toolNames(p)).toEqual(['echo', 'ping']);
    expect(up.initializeCount()).toBe(1);
    expect(p.isConnected('u1')).toBe(true);
    await p.sync([]);
    expect(p.isConnected('u1')).toBe(false);
  });

  it('TC-GW-04-2: injects the decrypted bearer / custom header, nothing else', async () => {
    const up = await fake();
    const p = pool();
    await p.sync([
      row({ id: 'b', slug: 'b', url: up.url, authType: 'bearer', credentialEnc: encryptCredential(key, 'b', 'tok-b') }),
      row({ id: 'h', slug: 'h', url: up.url, authType: 'header', authHeader: 'X-Api-Key', credentialEnc: encryptCredential(key, 'h', 'tok-h') }),
      row({ id: 'n', slug: 'n', url: up.url }),
    ]);
    await toolNames(p, 'b');
    expect(up.headers.at(-1)).toMatchObject({ authorization: 'Bearer tok-b' });
    await toolNames(p, 'h');
    expect(up.headers.at(-1)).toMatchObject({ 'x-api-key': 'tok-h' });
    expect(up.headers.at(-1)!.authorization).toBeUndefined();
    await toolNames(p, 'n');
    expect(up.headers.at(-1)!.authorization).toBeUndefined();
    expect(up.headers.at(-1)!['user-agent']).toMatch(/^mcp-gateway\//);
  });

  it('TC-GW-04-3: concurrent first use shares one connect', async () => {
    const up = await fake();
    const p = pool();
    await p.sync([row({ url: up.url })]);
    await Promise.all([toolNames(p), toolNames(p), toolNames(p)]);
    expect(up.initializeCount()).toBe(1);
  });

  it('TC-GW-04-4: sessionful upstream restarts → stale session → reconnects once transparently', async () => {
    const up = await fake({ sessionful: true });
    const p = pool();
    await p.sync([row({ url: up.url })]);
    await toolNames(p);
    up.restart();
    expect(await toolNames(p)).toEqual(['echo', 'ping']);
    expect(up.initializeCount()).toBe(2);
  });

  it('TC-GW-04-5: config change → connection rebuilt; disabled → closed and refused', async () => {
    const a = await fake({ tools: ['a'] });
    const b = await fake({ tools: ['b'] });
    const p = pool();
    await p.sync([row({ url: a.url })]);
    expect(await toolNames(p)).toEqual(['a']);
    await p.sync([row({ url: b.url, updatedAt: new Date() })]);
    expect(await toolNames(p)).toEqual(['b']);
    await p.sync([row({ url: b.url, enabled: false })]);
    await expect(toolNames(p)).rejects.toThrow(/not enabled/);
  });

  it('TC-GW-04-6: unreachable upstream → UpstreamUnavailableError quickly, without the URL', async () => {
    const up = await fake();
    const url = up.url;
    await up.close();
    const p = pool();
    await p.sync([row({ url })]);
    const t0 = Date.now();
    const err = await toolNames(p).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect(err.message).toMatch(/upstream woo unreachable/);
    expect(err.message).not.toContain('127.0.0.1');
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('TC-GW-04-7: upstream errors (JSON-RPC) are not retried', async () => {
    const up = await fake();
    const p = pool();
    await p.sync([row({ url: up.url })]);
    await toolNames(p);
    const before = up.headers.length;
    const r = await p.withClient('u1', (c) => c.callTool({ name: 'nope', arguments: {} }));
    expect(r.isError).toBe(true); // unknown tool → error result from the upstream, connection kept
    expect(up.headers.length - before).toBe(1);
    expect(up.initializeCount()).toBe(1);
  });
});

describe('upstream response size cap (T-08)', () => {
  const errText = (e: unknown): string => { let t = ''; for (let x = e as { message?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) t += ` ${x.message}`; return t; };

  it('TC-T08-1: a response over the cap is refused, smaller ones pass, the connection keeps working', async () => {
    const up = await fake({ tools: ['echo', 'big'] });
    const p = pool(64 * 1024);
    await p.sync([row({ url: up.url })]);
    const call = (bytes: number) => p.withClient('u1', (c) => c.callTool({ name: 'big', arguments: { bytes } }));
    const ok = await call(10_000);
    expect((ok.content as Array<{ text: string }>)[0]?.text).toHaveLength(10_000);
    const err = await call(200_000).then(() => null, (e: unknown) => e);
    expect(errText(err)).toContain('upstream response larger than 65536 bytes');
    expect(safeReason(err)).toBe('upstream response larger than 65536 bytes'); // what the client sees (route.ts)
    const again = await call(1_000);
    expect((again.content as Array<{ text: string }>)[0]?.text).toHaveLength(1_000);
  });

  it('TC-T08-2: a declared Content-Length over the cap is refused before the body is read', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(ctl) { pulled++; ctl.enqueue(new Uint8Array(10)); } });
    const res = new Response(body, { headers: { 'content-length': String(10_000_000) } });
    await expect(capResponse(res, 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's initial pull, never the 10 MB
  });

  it('TC-T08-3: the default cap leaves normal tool lists and calls alone', async () => {
    const up = await fake();
    const p = pool();
    await p.sync([row({ url: up.url })]);
    expect(await toolNames(p)).toEqual(['echo', 'ping']);
  });
});
