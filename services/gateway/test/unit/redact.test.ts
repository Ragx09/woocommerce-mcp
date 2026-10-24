// TC-UNIT-06 (GW-17): log redaction removes secrets; request ids; no tool arguments at info level.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { loggerOptions, scrubSecrets, scrubString } from '../../src/logger.js';
import { registerMcp } from '../../src/mcp/route.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { startFakeUpstream } from '../helpers/fake-upstream.js';
import { staticKeyAuth } from '../helpers/static-auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAT = `github_pat_${'A1b2'.repeat(20)}`;
const DEV_KEY = `mgw_dev_${'x'.repeat(40)}`;
const CK = `ck_${'a'.repeat(40)}`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function capture(level = 'info') {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, stream, logger: pino(loggerOptions(level), stream), text: () => lines.join('') };
}

describe('TC-UNIT-06 log redaction (GW-17)', () => {
  it('secret fields are censored at the top level, one level down and in nested headers', () => {
    const c = capture();
    c.logger.info({ token: 'tok-1', credential: 'cred-2', upstream: { pat: 'pat-3', apiKey: 'key-4', credentialEnc: 'enc-5' },
      outbound: { headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: 'sid=6' } }, slug: 'github' }, 'probe');
    const out = c.text();
    for (const s of ['tok-1', 'cred-2', 'pat-3', 'key-4', 'enc-5', 'dXNlcjpwYXNz', 'sid=6']) expect(out, s).not.toContain(s);
    expect(JSON.parse(out)).toMatchObject({ slug: 'github', token: '[redacted]', upstream: { pat: '[redacted]' } });
  });

  it('credential-shaped values are masked wherever they appear: messages, error text, unknown fields, arrays', () => {
    const c = capture();
    c.logger.warn({ err: `upstream said: invalid token ${PAT}`, detail: { note: [`Authorization: Bearer ${DEV_KEY}`] }, woo: CK },
      `retry with ${PAT}`);
    c.logger.error({ err: new Error(`connect failed for ${DEV_KEY}`) }, 'boom');
    const out = c.text();
    for (const s of [PAT, DEV_KEY, CK, PAT.slice(0, 30), DEV_KEY.slice(0, 20)]) expect(out, s).not.toContain(s);
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('gith…[redacted]'); // the kind of value stays visible
    expect(out).toContain('connect failed for mgw_…[redacted]');
  });

  it('ordinary text is left alone', () => {
    const plain = 'upstream woo unreachable: ECONNREFUSED; tools=64; tool github__get_me; ck_short';
    expect(scrubString(plain)).toBe(plain);
    expect(scrubSecrets({ a: [1, true, null], d: new Date(0) })).toEqual({ a: [1, true, null], d: new Date(0) });
  });
});

describe('TC-UNIT-06 request ids and tool-call logging (GW-17)', () => {
  const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
  const row = (url: string): Upstream => ({ id: 'u1', slug: 'woo', name: 'woo', url, enabled: true, authType: 'none',
    authHeader: null, credentialEnc: null, memberAccess: 'all', memberTools: [], createdBy: null, createdAt: new Date(0), updatedAt: new Date(0) });

  async function gateway(level: string) {
    const up = await startFakeUpstream({ tools: ['echo'] });
    cleanup.push(up.close);
    const c = capture(level);
    const app = buildApp(loadConfig({}), { logger: { ...loggerOptions(level), stream: c.stream } });
    const pool = new UpstreamPool({ key, connectTimeoutMs: 2_000 });
    registerMcp(app, { authenticate: staticKeyAuth(DEV_KEY), loadUpstreams: async () => [row(up.url)], pool,
      discovery: new ToolDiscovery(pool, { listTimeoutMs: 3_000 }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanup.unshift(async () => { await app.close(); await pool.close(); });
    const { port } = app.server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/mcp`, logs: c };
  }
  const SECRET_ARG = 'customer-email@example.com card 4111111111111111';

  it('tools/call at info: one line with request id, upstream, tool, outcome, ms — never the arguments or result', async () => {
    const { url, logs } = await gateway('info');
    const res = await fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${DEV_KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-request-id': 'client-chosen-id' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'woo__echo', arguments: { q: SECRET_ARG } } }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SECRET_ARG); // the fake echoes it back: the client gets it, the log must not
    const reqId = res.headers.get('x-request-id')!;
    expect(reqId).toMatch(UUID); // ours, not the client's
    const out = logs.text();
    expect(out).not.toContain(SECRET_ARG);
    expect(out).not.toContain('client-chosen-id');
    expect(out).not.toContain(DEV_KEY);
    const call = logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'tools/call');
    expect(call).toMatchObject({ reqId, upstream: 'woo', tool: 'echo', outcome: 'ok' });
    expect(Object.keys(call).sort()).toEqual(['keyId', 'level', 'ms', 'msg', 'outcome', 'reqId', 'svc', 'time', 'tool', 'upstream', 'userId']); // who called (AUTH-08)
    expect(logs.lines.every((l) => JSON.parse(l).reqId === reqId || JSON.parse(l).reqId === undefined)).toBe(true);
    // Fastify's own request lines keep their serialized fields (the scrubber must not flatten them).
    const parsed = logs.lines.map((l) => JSON.parse(l));
    expect(parsed.find((l) => l.msg === 'incoming request')).toMatchObject({ reqId, req: { method: 'POST', url: '/mcp' } });
    expect(parsed.find((l) => l.msg === 'request completed')).toMatchObject({ reqId, res: { statusCode: 200 } });
  });

  it('at debug: argument names only; probes are not logged at info', async () => {
    const { url, logs } = await gateway('debug');
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${DEV_KEY}` } } }));
    cleanup.unshift(() => c.close());
    await c.callTool({ name: 'woo__echo', arguments: { q: SECRET_ARG, page: 2 } });
    const out = logs.text();
    expect(out).not.toContain(SECRET_ARG);
    expect(logs.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'tools/call arguments')).toMatchObject({ argNames: ['q', 'page'] });

    const info = await gateway('info');
    const health = await fetch(info.url.replace('/mcp', '/healthz'));
    expect(health.headers.get('x-request-id')).toMatch(UUID);
    expect(info.logs.text()).not.toContain('/healthz');
  });
});
