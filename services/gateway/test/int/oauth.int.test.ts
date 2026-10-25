// TC-BON-08-1 / TC-BON-08-2 (BON-08): OAuth 2.1 on the real gateway routes with real Postgres.
// 1: the SDK's own client auth flow (401 → RFC 9728 → RFC 8414 → dynamic registration → authorize with PKCE →
//    dashboard consent → token) ends in tools/list as the user, audited with source=oauth; refresh rotation;
//    wrong verifier / redirect / replayed code refused; revoke and disable → 401 on the next call; API keys unchanged.
// 2: tokens are bound to this resource: another resource is refused at authorize, at token and at /mcp.
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { dbAuditSink } from '../../src/audit/audit.js';
import { createApiKey } from '../../src/auth/api-keys.js';
import { InternalTokenSigner, mcpAuthenticator } from '../../src/auth/internal-token.js';
import { hashPassword } from '../../src/auth/password.js';
import { registerAuth } from '../../src/auth/routes.js';
import { loadConfig } from '../../src/config.js';
import { loadCredentialKey } from '../../src/crypto/credentials.js';
import { createDb, createPool, loadDbConfig, runMigrations, type Db } from '../../src/db/index.js';
import { users } from '../../src/db/schema.js';
import { registerMcp } from '../../src/mcp/route.js';
import { registerOAuth, resourceFor, resourceMetadataUrl } from '../../src/oauth/routes.js';
import { s256 } from '../../src/oauth/store.js';
import { MemoryRateLimiter } from '../../src/ratelimit.js';
import { ToolDiscovery } from '../../src/upstreams/discovery.js';
import { UpstreamPool } from '../../src/upstreams/pool.js';
import { listUpstreams } from '../../src/upstreams/repo.js';
import { startFakeUpstream, type FakeUpstream } from '../helpers/fake-upstream.js';

const base = loadDbConfig();
const adminPool = createPool({ ...base, database: 'postgres' });
const dbName = `gw_oauth_${randomUUID().slice(0, 8)}`;
const PW = 'oauth-test-password';
const REDIRECT = 'http://127.0.0.1:33418/callback';
let pool: pg.Pool;
let db: Db;
let app: FastifyInstance;
let upstreamPool: UpstreamPool;
let woo: FakeUpstream;
let origin: string;
let aliceId: string;
let aliceKey: string;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const rows = async () => (await pool.query('SELECT user_id, api_key_id, source, method, outcome FROM audit_log ORDER BY id')).rows;

/** An MCP client's OAuth state, in memory (what Claude Code keeps in its keychain). */
class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed; saved?: OAuthTokens; verifier = ''; authUrl?: URL;
  constructor(readonly redirect = REDIRECT) {}
  get redirectUrl() { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Test MCP client', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

/** The browser part: follow /oauth/authorize to the consent page and decide as the signed-in user. */
async function consent(authUrl: URL, cookie: string, approve = true): Promise<URL> {
  const res = await fetch(authUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const consentUrl = new URL(res.headers.get('location')!);
  expect(consentUrl.origin + consentUrl.pathname).toBe(`${origin}/connect`);
  const request = consentUrl.searchParams.get('request')!;
  const shown = await app.inject({ method: 'POST', url: '/api/oauth/consent', headers: { cookie, origin }, payload: { request } });
  expect(shown.json()).toMatchObject({ client: 'Test MCP client', redirectTo: 'http://127.0.0.1:33418', scope: 'mcp' });
  const decided = await app.inject({ method: 'POST', url: '/api/oauth/consent/decision', headers: { cookie, origin }, payload: { request, approve } });
  expect(decided.statusCode).toBe(200);
  return new URL(decided.json().redirect);
}

/** A full login with the SDK's client flow; returns the provider holding the tokens. */
async function connectWithOAuth(cookie: string): Promise<Provider> {
  const p = new Provider();
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: p });
  await expect(new Client({ name: 't', version: '1' }).connect(transport)).rejects.toThrow(/Unauthorized/);
  const back = await consent(p.authUrl!, cookie);
  expect(back.searchParams.get('iss')).toBe(origin);
  await transport.finishAuth(back.searchParams.get('code')!);
  return p;
}

const mcpList = (bearer: string) => fetch(`${origin}/mcp`, { method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
/** Response JSON, untyped (each test reads the fields it checks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const form = (body: Record<string, string>) => fetch(`${origin}/oauth/token`, { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

/** Registers a client and returns an authorization code for alice, by hand (no SDK), with a known verifier. */
async function manualCode(cookie: string, extra: Record<string, string> = {}) {
  const reg = await j(fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test MCP client', redirect_uris: [REDIRECT] }) })) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const u = new URL(`${origin}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: s256(verifier),
    code_challenge_method: 'S256', state: 'st-1', resource: resourceFor(origin), ...extra })) u.searchParams.set(k, v);
  const back = await consent(u, cookie);
  return { clientId: reg.client_id, verifier, code: back.searchParams.get('code')!, state: back.searchParams.get('state') };
}

beforeAll(async () => {
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  pool = createPool({ ...base, database: dbName });
  await runMigrations(pool);
  db = createDb(pool);
  const hash = await hashPassword(PW);
  const [a] = await db.insert(users).values({ email: 'alice@example.test', name: 'Alice', passwordHash: hash }).returning({ id: users.id });
  aliceId = a!.id;
  aliceKey = (await createApiKey(db, aliceId, 'k', aliceId)).key;
  woo = await startFakeUpstream({ tools: ['echo'] });
  await pool.query(`INSERT INTO upstreams (slug, name, url) VALUES ('woo', 'Woo', $1)`, [woo.url]);

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  app = buildApp(loadConfig({ LOG_LEVEL: 'silent', TRUST_PROXY_HOPS: '0' }));
  await registerAuth(app, { db, cookieSecure: false, publicOrigin: origin });
  registerOAuth(app, { db, issuer: origin, limiter: new MemoryRateLimiter(), limits: { registerPerHour: 1000, tokenPerMinute: 1000, authorizePerMinute: 1000 } });
  upstreamPool = new UpstreamPool({ key: loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') }), connectTimeoutMs: 1_000 });
  registerMcp(app, { authenticate: mcpAuthenticator(db, new InternalTokenSigner(), resourceFor(origin)), resourceMetadataUrl: resourceMetadataUrl(origin),
    loadUpstreams: () => listUpstreams(db), pool: upstreamPool, discovery: new ToolDiscovery(upstreamPool, { listTimeoutMs: 2_000 }), audit: dbAuditSink(db, app.log) });
  await app.listen({ port, host: '127.0.0.1' });
});
afterAll(async () => {
  await app?.close();
  await upstreamPool?.close();
  await woo?.close();
  pool?.on('error', () => {});
  await pool?.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await adminPool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE audit_log');
  await pool.query('UPDATE users SET disabled_at = NULL');
});

describe('discovery', () => {
  it('401 from /mcp names the resource metadata; both metadata documents describe this server', async () => {
    const res = await mcpList('');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`);
    const prm = await j(fetch(`${origin}/.well-known/oauth-protected-resource/mcp`));
    expect(prm).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    const as = await j(fetch(`${origin}/.well-known/oauth-authorization-server`));
    expect(as).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  });
});

describe('TC-BON-08-1 code + PKCE flow', () => {
  it('the SDK client logs in through the dashboard consent and lists tools as the user (source=oauth)', async () => {
    const p = await connectWithOAuth(await login('alice@example.test'));
    expect(p.saved?.access_token).toMatch(/^mat_/);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: p }));
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['woo__echo']);
    expect((await c.callTool({ name: 'woo__echo', arguments: { text: 'hi' } })).isError).toBeFalsy();
    await c.close();
    const calls = (await rows()).filter((r) => r.method === 'tools/list' || r.method === 'tools/call');
    expect(calls).toEqual([
      { user_id: aliceId, api_key_id: null, source: 'oauth', method: 'tools/list', outcome: 'ok' },
      { user_id: aliceId, api_key_id: null, source: 'oauth', method: 'tools/call', outcome: 'ok' },
    ]);
  });

  it('refresh tokens rotate; replaying an old one revokes the whole grant', async () => {
    const cookie = await login('alice@example.test');
    const m = await manualCode(cookie);
    expect(m.state).toBe('st-1');
    const t1 = await j(form({ grant_type: 'authorization_code', client_id: m.clientId, code: m.code, redirect_uri: REDIRECT, code_verifier: m.verifier }));
    const t2res = await form({ grant_type: 'refresh_token', client_id: m.clientId, refresh_token: t1.refresh_token });
    expect(t2res.status).toBe(200);
    const t2 = await j(t2res);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await mcpList(t2.access_token)).status).toBe(200);
    const replay = await form({ grant_type: 'refresh_token', client_id: m.clientId, refresh_token: t1.refresh_token });
    expect([replay.status, (await j(replay)).error]).toEqual([400, 'invalid_grant']);
    expect((await mcpList(t2.access_token)).status).toBe(401); // the grant is gone, current tokens too
  });

  it('wrong verifier burns the code; wrong redirect, other client and replayed codes are refused', async () => {
    const cookie = await login('alice@example.test');
    const a = await manualCode(cookie);
    const wrong = await form({ grant_type: 'authorization_code', client_id: a.clientId, code: a.code, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString('base64url') });
    expect([wrong.status, (await j(wrong)).error]).toEqual([400, 'invalid_grant']);
    const after = await form({ grant_type: 'authorization_code', client_id: a.clientId, code: a.code, redirect_uri: REDIRECT, code_verifier: a.verifier });
    expect(after.status).toBe(400); // single use, even after a failed attempt

    const b = await manualCode(cookie);
    const badRedirect = await form({ grant_type: 'authorization_code', client_id: b.clientId, code: b.code, redirect_uri: 'http://127.0.0.1:9/other', code_verifier: b.verifier });
    expect(badRedirect.status).toBe(400);

    const c = await manualCode(cookie);
    const other = await manualCode(cookie);
    const otherClient = await form({ grant_type: 'authorization_code', client_id: other.clientId, code: c.code, redirect_uri: REDIRECT, code_verifier: c.verifier });
    expect(otherClient.status).toBe(400);

    const d = await manualCode(cookie);
    const ok = await j(form({ grant_type: 'authorization_code', client_id: d.clientId, code: d.code, redirect_uri: REDIRECT, code_verifier: d.verifier }));
    expect((await mcpList(ok.access_token)).status).toBe(200);
    const replay = await form({ grant_type: 'authorization_code', client_id: d.clientId, code: d.code, redirect_uri: REDIRECT, code_verifier: d.verifier });
    expect(replay.status).toBe(400);
    expect((await mcpList(ok.access_token)).status).toBe(401); // code replay revokes what it issued
  });

  it('revoking the grant (user) or disabling the user → 401 on the next call; API keys keep working', async () => {
    const cookie = await login('alice@example.test');
    const m = await manualCode(cookie);
    const t = await j(form({ grant_type: 'authorization_code', client_id: m.clientId, code: m.code, redirect_uri: REDIRECT, code_verifier: m.verifier }));
    expect((await mcpList(t.access_token)).status).toBe(200);
    const grants = (await app.inject({ method: 'GET', url: '/api/oauth/grants', headers: { cookie } })).json() as { id: string; revokedAt: string | null }[];
    const live = grants.find((g) => !g.revokedAt)!;
    expect(JSON.stringify(grants)).not.toMatch(/mat_|mrt_|mac_|hash/);
    expect((await app.inject({ method: 'DELETE', url: `/api/oauth/grants/${live.id}`, headers: { cookie, origin } })).statusCode).toBe(204);
    expect((await mcpList(t.access_token)).status).toBe(401);

    const m2 = await manualCode(cookie);
    const t2 = await j(form({ grant_type: 'authorization_code', client_id: m2.clientId, code: m2.code, redirect_uri: REDIRECT, code_verifier: m2.verifier }));
    expect((await mcpList(t2.access_token)).status).toBe(200);
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [aliceId]);
    expect((await mcpList(t2.access_token)).status).toBe(401);
    expect((await form({ grant_type: 'refresh_token', client_id: m2.clientId, refresh_token: t2.refresh_token })).status).toBe(400);
    await pool.query('UPDATE users SET disabled_at = NULL');
    expect((await mcpList(aliceKey)).status).toBe(200);
  });

  it('a denied consent sends access_denied back; the request cannot be decided twice', async () => {
    const cookie = await login('alice@example.test');
    const p = new Provider();
    await auth(p, { serverUrl: `${origin}/mcp` });
    const back = await consent(p.authUrl!, cookie, false);
    expect(back.searchParams.get('error')).toBe('access_denied');
  });
});

describe('authorize and registration rules', () => {
  const register = (body: unknown) => fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('refuses non-loopback http, script schemes, fragments and confidential clients', async () => {
    for (const r of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://ok.example/cb#frag', 'https://u:p@ok.example/cb']) {
      expect((await register({ redirect_uris: [r] })).status, r).toBe(400);
    }
    expect((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    expect((await register({ redirect_uris: ['https://ok.example/cb', 'com.example.app:/cb', REDIRECT] })).status).toBe(201);
  });

  it('unknown client or unregistered redirect → plain 400, never a redirect; missing PKCE → error to the client', async () => {
    const reg = await j(register({ redirect_uris: [REDIRECT] }));
    const q = (p: Record<string, string>) => fetch(`${origin}/oauth/authorize?${new URLSearchParams(p)}`, { redirect: 'manual' });
    const pkce = { code_challenge: s256(randomBytes(32).toString('base64url')), code_challenge_method: 'S256', response_type: 'code' };
    const unknown = await q({ ...pkce, client_id: 'mcpc_nope_nope_nope_nope_nope', redirect_uri: REDIRECT });
    expect([unknown.status, unknown.headers.get('location')]).toEqual([400, null]);
    const evil = await q({ ...pkce, client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:1/evil' });
    expect([evil.status, evil.headers.get('location')]).toEqual([400, null]);
    const noPkce = await q({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', state: 's' });
    const loc = new URL(noPkce.headers.get('location')!);
    expect([noPkce.status, loc.origin + loc.pathname, loc.searchParams.get('error'), loc.searchParams.get('state')]).toEqual([302, 'http://127.0.0.1:33418/callback', 'invalid_request', 's']);
    const plain = await q({ ...pkce, code_challenge_method: 'plain', client_id: reg.client_id, redirect_uri: REDIRECT });
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('the consent decision is a session + same-origin request (no cookie → 401, foreign Origin → 403)', async () => {
    const cookie = await login('alice@example.test');
    expect((await app.inject({ method: 'POST', url: '/api/oauth/consent/decision', payload: { request: 'x'.repeat(43), approve: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/oauth/consent/decision', headers: { cookie, origin: 'https://evil.example' }, payload: { request: 'x'.repeat(43), approve: true } })).statusCode).toBe(403);
  });
});

describe('rate limits', () => {
  it('registration is limited per client IP (429 + Retry-After)', async () => {
    const small = buildApp(loadConfig({ LOG_LEVEL: 'silent' }));
    registerOAuth(small, { db, issuer: origin, limiter: new MemoryRateLimiter(), limits: { registerPerHour: 2, tokenPerMinute: 2, authorizePerMinute: 2 } });
    const reg = () => small.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [REDIRECT] } });
    expect([(await reg()).statusCode, (await reg()).statusCode]).toEqual([201, 201]);
    const third = await reg();
    expect([third.statusCode, Number(third.headers['retry-after']) > 0]).toEqual([429, true]);
    await small.close();
  });
});

describe('TC-BON-08-2 tokens are bound to this resource', () => {
  it('another resource is refused at authorize and at token; a token for another resource is refused at /mcp', async () => {
    const cookie = await login('alice@example.test');
    const reg = await j(fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
    const u = new URL(`${origin}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: s256('v'.repeat(43)),
      code_challenge_method: 'S256', resource: 'https://other.example/mcp' })) u.searchParams.set(k, v);
    const res = await fetch(u, { redirect: 'manual' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');

    const m = await manualCode(cookie);
    const wrongTarget = await form({ grant_type: 'authorization_code', client_id: m.clientId, code: m.code, redirect_uri: REDIRECT, code_verifier: m.verifier, resource: 'https://other.example/mcp' });
    expect((await j(wrongTarget)).error).toBe('invalid_target');

    const m2 = await manualCode(cookie);
    const t = await j(form({ grant_type: 'authorization_code', client_id: m2.clientId, code: m2.code, redirect_uri: REDIRECT, code_verifier: m2.verifier }));
    // The same token presented to a gateway whose resource is different (another deployment) is refused.
    const otherAuth = mcpAuthenticator(db, new InternalTokenSigner(), 'https://other.example/mcp');
    expect(await otherAuth(t.access_token, { loopback: false })).toBeNull();
    expect(await mcpAuthenticator(db, new InternalTokenSigner(), resourceFor(origin))(t.access_token, { loopback: false })).toMatchObject({ userId: aliceId, source: 'oauth' });
    // And with OAuth off (no public origin) access tokens are not accepted at all.
    expect(await mcpAuthenticator(db, new InternalTokenSigner())(t.access_token, { loopback: false })).toBeNull();
  });
});
