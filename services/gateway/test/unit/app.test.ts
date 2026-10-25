import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { loggerOptions } from '../../src/logger.js';

const cfg = loadConfig({ LOG_LEVEL: 'silent' });

describe('probes', () => {
  it('TC-GW-01-1: /healthz → 200', async () => {
    const app = buildApp(cfg);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('TC-GW-01-2: /readyz → 200 with all checks passing, 503 naming the failed ones', async () => {
    const ok = buildApp(cfg, { readinessChecks: [{ name: 'db', check: async () => true }] });
    expect((await ok.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);

    const bad = buildApp(cfg, {
      readinessChecks: [
        { name: 'db', check: async () => true },
        { name: 'throws', check: async () => { throw new Error('boom'); } },
        { name: 'false', check: async () => false },
      ],
    });
    const res = await bad.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', failed: ['throws', 'false'] });
  });
});

describe('security headers (SEC-07, F-WEB-9)', () => {
  it('TC-SEC-07-U1: every response has nosniff, no framing, no-store, no referrer; HSTS only behind TLS', async () => {
    const app = buildApp(loadConfig({ LOG_LEVEL: 'silent', TRUST_PROXY_HOPS: '1' }));
    for (const url of ['/healthz', '/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
    const tls = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-proto': 'https' } });
    expect(tls.headers['strict-transport-security']).toBe('max-age=31536000');
    const direct = buildApp(loadConfig({ LOG_LEVEL: 'silent', TRUST_PROXY_HOPS: '0' })); // no proxy trusted: a client header is ignored
    expect((await direct.inject({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-proto': 'https' } })).headers['strict-transport-security']).toBeUndefined();
  });
});

describe('error shape', () => {
  it('TC-GW-01-3: unknown route → 404 { error: not_found }', async () => {
    const res = await buildApp(cfg).inject({ method: 'GET', url: '/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'GET /nope not found' });
  });

  it('TC-GW-01-4: thrown error → 500 without leaking the message', async () => {
    const app = buildApp(cfg);
    app.get('/boom', async () => { throw new Error('db password is hunter2'); });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'internal error' });
  });

  it('TC-GW-01-5: oversized body → 413', async () => {
    const app = buildApp(loadConfig({ LOG_LEVEL: 'silent', BODY_LIMIT_BYTES: '1024' }));
    app.post('/echo', async (req) => req.body);
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { x: 'a'.repeat(2000) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });
});

describe('logging', () => {
  it('TC-GW-01-6: secrets in headers and fields are redacted', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const app = buildApp(cfg, { logger: { ...loggerOptions('info'), stream } });
    app.get('/log', async (req) => {
      req.log.info({ req: { headers: req.headers }, body: { password: 'pw-123', credential: 'cred-456', token: 'tok-789' } }, 'probe');
      return {};
    });
    await app.inject({ method: 'GET', url: '/log', headers: { authorization: 'Bearer sk-live-abc', cookie: 'sid=s3cr3t' } });
    const out = lines.join('');
    expect(out).toContain('probe');
    for (const secret of ['sk-live-abc', 's3cr3t', 'pw-123', 'cred-456', 'tok-789']) expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });
});

describe('config', () => {
  it('TC-GW-01-7: rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(loadConfig({}).port).toBe(8080);
  });

  it('TC-UI-13-1: LLM defaults to Groq, is configurable, and rejects unsafe base URLs', () => {
    expect(loadConfig({}).llm).toEqual({
      baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', apiKey: undefined, timeoutMs: 30_000, maxTokens: 1_024,
    });
    const or = loadConfig({ LLM_BASE_URL: 'https://openrouter.ai/api/v1/', LLM_MODEL: 'openai/gpt-oss-120b:free', LLM_API_KEY: ' k ' }).llm;
    expect(or).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b:free', apiKey: 'k' });
    expect(loadConfig({ LLM_API_KEY: '  ' }).llm.apiKey).toBeUndefined();
    for (const bad of ['ftp://x/v1', 'not a url', 'https://user:pw@x/v1', 'https://x/v1?key=1', 'https://x/v1#f']) {
      expect(() => loadConfig({ LLM_BASE_URL: bad })).toThrow(/LLM_BASE_URL/);
    }
    expect(() => loadConfig({ LLM_TIMEOUT_MS: '0' })).toThrow(/LLM_TIMEOUT_MS/);
    expect(() => loadConfig({ LLM_MAX_OUTPUT: '99999' })).toThrow(/LLM_MAX_OUTPUT/);
  });

  it('TC-GW-09-1: upstream timeouts default to 2/3/15 s, are configurable and range-checked', () => {
    expect(loadConfig({}).upstreamTimeouts).toEqual({ connectMs: 2_000, listMs: 3_000, callMs: 15_000 });
    expect(loadConfig({ UPSTREAM_CALL_TIMEOUT_MS: '30000' }).upstreamTimeouts.callMs).toBe(30_000);
    expect(() => loadConfig({ UPSTREAM_CALL_TIMEOUT_MS: '0' })).toThrow(/UPSTREAM_CALL_TIMEOUT_MS/);
    expect(() => loadConfig({ UPSTREAM_LIST_TIMEOUT_MS: '1.5' })).toThrow(/UPSTREAM_LIST_TIMEOUT_MS/);
    expect(() => loadConfig({ UPSTREAM_CONNECT_TIMEOUT_MS: '999999' })).toThrow(/UPSTREAM_CONNECT_TIMEOUT_MS/);
    expect(loadConfig({}).healthIntervalMs).toBe(10_000);
    expect(() => loadConfig({ HEALTH_INTERVAL_MS: '10' })).toThrow(/HEALTH_INTERVAL_MS/);
  });
});
