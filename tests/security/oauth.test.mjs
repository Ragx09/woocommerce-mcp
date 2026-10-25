// SEC-09 / BON-08 attack suite for the gateway's OAuth authorization server (live: a cluster, or a gateway started by hand with
// PUBLIC_ORIGIN set and the SEC_* variables of lib.mjs). Everything here must be REFUSED or must not leak; the happy path is
// scripts/e2e-oauth.mjs. Registers a few throwaway clients (OAuth clients are public metadata; they expire with the DB rows).
// The endpoints are rate-limited per IP (a minute window): run this file once per minute at most, or the later tests see 429.
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, api, demoUsers, rand } from './lib.mjs';

let b;
const LOOP = 'http://127.0.0.1:33418/callback';
const challengeOf = (v) => createHash('sha256').update(v).digest('base64url');
const verifier = () => randomBytes(32).toString('base64url');
const form = (o) => new URLSearchParams(o).toString();
const register = (body) => fetch(`${APP}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const authorize = (params) => fetch(`${APP}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
const token = (o, headers = {}) => fetch(`${APP}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(o) });
let client;
async function newClient(redirect = LOOP) {
  const r = await register({ client_name: `sec ${rand(3)}`, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  return (await r.json()).client_id;
}
/** A full authorization up to the code, as user B in the dashboard (the consent step the browser would do). */
async function codeFor(clientId, v, redirect = LOOP) {
  const az = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challengeOf(v), code_challenge_method: 'S256', resource: `${APP}/mcp`, state: 'st' });
  const request = new URL(az.headers.get('location')).searchParams.get('request');
  const d = await api('POST', '/api/oauth/consent/decision', { cookie: b.cookie, body: { request, approve: true } });
  return { request, code: new URL(d.body.redirect).searchParams.get('code'), redirect: d.body.redirect };
}

beforeAll(async () => { ({ b } = await demoUsers()); client = await newClient(); });

describe('TC-SEC-12-1 client registration', () => {
  it('dangerous or malformed redirect URIs and metadata are refused', async () => {
    const bad = ['javascript:alert(1)', 'data:text/html,<script>', 'http://evil.example/cb', 'https://user:pw@evil.example/cb', 'http://127.0.0.1:1/cb#frag', 'file:///etc/passwd', 'ftp://127.0.0.1/cb', '//evil.example/cb', 'http://localhost.evil.example/cb', '', 'x'.repeat(3000)];
    for (const uri of bad) expect.soft((await register({ redirect_uris: [uri] })).status, uri.slice(0, 40)).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: Array(20).fill(LOOP) })).status).toBe(400);
    expect((await register({ redirect_uris: [LOOP], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    expect((await register({ redirect_uris: [LOOP], grant_types: ['implicit'] })).status).toBe(400);
    expect((await register({ redirect_uris: [LOOP], grant_types: ['password'] })).status).toBe(400);
    expect((await register({ redirect_uris: [LOOP], response_types: ['token'] })).status).toBe(400);
  });
  it('the client name shown on the consent page carries no control or bidi characters', async () => {
    const r = await register({ client_name: 'Trusted‮evil\u0000\nApp', redirect_uris: [LOOP] });
    expect(r.status).toBe(201);
    expect((await r.json()).client_name).not.toMatch(/[‮\u0000\n]/);
  });
});

describe('TC-SEC-12-2 authorization endpoint', () => {
  const base = () => ({ response_type: 'code', client_id: client, redirect_uri: LOOP, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', state: 'x' });
  it('an unregistered or look-alike redirect_uri never receives a redirect (no open redirect)', async () => {
    for (const redirect_uri of ['http://evil.example/cb', `${LOOP}/../x`, `${LOOP}?a=b`, `${LOOP}#f`, 'http://127.0.0.1:33418/callback/', 'http://127.0.0.1:33419/callback', 'HTTP://127.0.0.1:33418/callback']) {
      const r = await authorize({ ...base(), redirect_uri });
      expect.soft([r.status, r.headers.get('location')], redirect_uri).toEqual([400, null]);
    }
    const unknown = await authorize({ ...base(), client_id: 'mcpc_' + 'x'.repeat(20) });
    expect([unknown.status, unknown.headers.get('location')]).toEqual([400, null]);
    expect((await authorize({ ...base(), redirect_uri: undefined })).status).toBe(400);
  });
  it('downgrades are refused (errors go back only to the registered URI): no PKCE, plain, short challenge, implicit, bad scope, other resource', async () => {
    const refused = async (over, error) => {
      const r = await authorize({ ...base(), ...over });
      const loc = new URL(r.headers.get('location') ?? 'http://none/');
      expect.soft([r.status, loc.origin + loc.pathname, loc.searchParams.get('error')], JSON.stringify(over).slice(0, 60)).toEqual([302, new URL(LOOP).origin + new URL(LOOP).pathname, error]);
    };
    await refused({ code_challenge: undefined }, 'invalid_request');
    await refused({ code_challenge_method: 'plain' }, 'invalid_request');
    await refused({ code_challenge_method: undefined }, 'invalid_request');
    await refused({ code_challenge: 'short' }, 'invalid_request');
    await refused({ response_type: 'token' }, 'unsupported_response_type');
    await refused({ response_type: 'code token' }, 'unsupported_response_type');
    await refused({ scope: 'mcp admin' }, 'invalid_scope');
    await refused({ resource: 'https://other.example/mcp' }, 'invalid_target');
    await refused({ state: 'x'.repeat(600) }, 'invalid_request');
  });
  it('repeated parameters (parameter pollution) are refused', async () => {
    const q = `response_type=code&client_id=${client}&client_id=${client}&redirect_uri=${encodeURIComponent(LOOP)}&code_challenge=${challengeOf(verifier())}&code_challenge_method=S256`;
    const r = await fetch(`${APP}/oauth/authorize?${q}`, { redirect: 'manual' });
    expect([r.status, r.headers.get('location')]).toEqual([400, null]);
  });
});

describe('TC-SEC-12-3 consent step', () => {
  it('needs a session and a browser header; a foreign origin or an unknown/used request id gets nothing', async () => {
    const v = verifier();
    const az = await authorize({ response_type: 'code', client_id: client, redirect_uri: LOOP, code_challenge: challengeOf(v), code_challenge_method: 'S256' });
    const request = new URL(az.headers.get('location')).searchParams.get('request');
    expect((await api('POST', '/api/oauth/consent', { body: { request } })).status).toBe(401);
    expect((await api('POST', '/api/oauth/consent/decision', { body: { request, approve: true } })).status).toBe(401);
    expect((await api('POST', '/api/oauth/consent/decision', { cookie: b.cookie, body: { request, approve: true }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('POST', '/api/oauth/consent/decision', { cookie: b.cookie, body: { request, approve: true }, origin: false })).status).toBe(403);
    expect((await api('POST', '/api/oauth/consent/decision', { cookie: b.cookie, body: { request: 'nope', approve: true } })).status).toBe(404);
    expect((await api('POST', '/api/oauth/consent/decision', { cookie: b.cookie, body: { request, approve: false } })).status).toBe(200);
    expect((await api('POST', '/api/oauth/consent/decision', { cookie: b.cookie, body: { request, approve: true } })).status).toBe(404); // consumed
  });
  it('the consent answer never contains tokens, hashes or another user\'s data', async () => {
    const az = await authorize({ response_type: 'code', client_id: client, redirect_uri: LOOP, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' });
    const request = new URL(az.headers.get('location')).searchParams.get('request');
    const shown = await api('POST', '/api/oauth/consent', { cookie: b.cookie, body: { request } });
    expect(shown.status).toBe(200);
    expect(shown.text).not.toMatch(/mat_|mrt_|hash|argon|passwordHash/i);
    expect(Object.keys(shown.body).sort()).toEqual(['client', 'redirectTo', 'resource', 'scope', 'user']);
  });
});

describe('TC-SEC-12-4 token endpoint', () => {
  it('a code works once, only with its verifier, redirect URI, client and resource; a replay revokes what it issued', async () => {
    const v = verifier();
    const { code } = await codeFor(client, v);
    expect((await token({ grant_type: 'authorization_code', client_id: client, code, redirect_uri: LOOP, code_verifier: verifier() })).status).toBe(400); // wrong verifier burns the code
    expect((await token({ grant_type: 'authorization_code', client_id: client, code, redirect_uri: LOOP, code_verifier: v })).status).toBe(400); // so even the right one is too late
    const v2 = verifier();
    const second = await codeFor(client, v2);
    expect((await token({ grant_type: 'authorization_code', client_id: client, code: second.code, redirect_uri: 'http://127.0.0.1:33418/other', code_verifier: v2 })).status).toBe(400);
    const v3 = verifier();
    const third = await codeFor(client, v3);
    const otherClient = await newClient();
    expect((await token({ grant_type: 'authorization_code', client_id: otherClient, code: third.code, redirect_uri: LOOP, code_verifier: v3 })).status).toBeGreaterThanOrEqual(400);
    const v4 = verifier();
    const fourth = await codeFor(client, v4);
    const ok = await token({ grant_type: 'authorization_code', client_id: client, code: fourth.code, redirect_uri: LOOP, code_verifier: v4, resource: `${APP}/mcp` });
    expect(ok.status).toBe(200);
    const t = await ok.json();
    expect(t.access_token).toMatch(/^mat_/);
    expect(ok.headers.get('cache-control')).toMatch(/no-store/);
    // Replaying the used code revokes the grant it created.
    expect((await token({ grant_type: 'authorization_code', client_id: client, code: fourth.code, redirect_uri: LOOP, code_verifier: v4 })).status).toBe(400);
    const probe = await fetch(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(probe.status).toBe(401);
  });
  it('wrong content type, unknown client, odd grant types, resource mismatch and malformed bodies are refused without a 5xx', async () => {
    const calls = [
      token({ grant_type: 'password', client_id: client, username: 'a', password: 'b' }), token({ grant_type: 'client_credentials', client_id: client }), token({ grant_type: 'authorization_code', client_id: 'mcpc_nope' }),
      token({ grant_type: 'authorization_code', client_id: client, code: 'x', redirect_uri: LOOP, code_verifier: 'x', resource: 'https://other.example/mcp' }),
      token({ grant_type: 'refresh_token', client_id: client, refresh_token: 'mrt_' + 'a'.repeat(40) }), token({}),
      fetch(`${APP}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id: client }) }),
      fetch(`${APP}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&grant_type=refresh_token&client_id=' + client }),
      fetch(`${APP}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a'.repeat(200_000) }),
    ];
    for (const [i, p] of calls.entries()) { const r = await p; expect.soft(r.status, `case ${i}`).toBeGreaterThanOrEqual(400); expect.soft(r.status, `case ${i}`).toBeLessThan(500); const t = await r.text(); expect.soft(t, `case ${i}`).not.toMatch(/stack| at .*\.js|pg_|postgres/i); }
  });
  it('a refresh token rotates, and replaying the old one ends the whole grant', async () => {
    const v = verifier(); const { code } = await codeFor(client, v);
    const t1 = await (await token({ grant_type: 'authorization_code', client_id: client, code, redirect_uri: LOOP, code_verifier: v })).json();
    const t2res = await token({ grant_type: 'refresh_token', client_id: client, refresh_token: t1.refresh_token });
    expect(t2res.status).toBe(200);
    const t2 = await t2res.json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await token({ grant_type: 'refresh_token', client_id: client, refresh_token: t1.refresh_token })).status).toBe(400); // replay
    expect((await token({ grant_type: 'refresh_token', client_id: client, refresh_token: t2.refresh_token })).status).toBe(400); // grant revoked
  });
  it('an access token minted for this resource does not work for admin API routes, and a revoked grant dies on the next call', async () => {
    const v = verifier(); const { code } = await codeFor(client, v);
    const t = await (await token({ grant_type: 'authorization_code', client_id: client, code, redirect_uri: LOOP, code_verifier: v })).json();
    for (const path of ['/api/me', '/api/users', '/api/keys', '/api/stores']) {
      const r = await fetch(`${APP}${path}`, { headers: { authorization: `Bearer ${t.access_token}` } });
      expect.soft(r.status, path).toBe(401); // /api takes the session cookie only
    }
    await fetch(`${APP}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: client, token: t.access_token }) });
    const after = await fetch(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(after.status).toBe(401);
  });
});

describe('TC-SEC-12-5 metadata and /mcp challenge', () => {
  it('discovery documents advertise only what is supported, with S256 only and no secrets', async () => {
    const as = await (await fetch(`${APP}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.grant_types_supported.sort()).toEqual(['authorization_code', 'refresh_token']);
    expect(as.response_types_supported).toEqual(['code']);
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(JSON.stringify(as)).not.toMatch(/secret|password|key/i);
    const rs = await (await fetch(`${APP}/.well-known/oauth-protected-resource`)).json();
    expect(rs.resource).toBe(`${APP}/mcp`);
  });
  it('the 401 from /mcp names the metadata URL and nothing about why (no oracle between missing, malformed and revoked tokens)', async () => {
    const probe = async (auth) => fetch(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    const answers = [];
    for (const auth of [undefined, 'Bearer mat_' + 'a'.repeat(43), 'Bearer mgw_' + 'a'.repeat(43), 'Bearer garbage', 'Basic Zm9vOmJhcg==']) { const r = await probe(auth); answers.push([r.status, (await r.json()).error]); }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0][0]).toBe(401);
  });
});
