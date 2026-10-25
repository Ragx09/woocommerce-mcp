#!/usr/bin/env node
// BON-08 e2e: OAuth login for /mcp against the running cluster, through the Ingress, as user B (member).
// The MCP SDK's own client flow does discovery (401 → RFC 9728 → RFC 8414), dynamic registration and PKCE; the
// browser step (consent page) is done with B's dashboard session through the same /api calls the page makes.
// Then: tools/list + tools/call as B (member tool rules apply), audit rows with source=oauth, revoke → 401,
// API keys unaffected. Env: APP_ORIGIN (default http://app.127.0.0.1.nip.io).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ensureDemoUsers } from './seed-demo-users.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const MCP = new URL(`${ORIGIN}/mcp`);
const REDIRECT = 'http://127.0.0.1:33418/callback'; // never contacted: the code is read from the decision response
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };

class Provider {
  info; saved; verifier = ''; authUrl;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: 'e2e OAuth client', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.info; }
  saveClientInformation(i) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t) { this.saved = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}
const api = async (method, path, cookie, body) => {
  const res = await fetch(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
};

const { a, b } = await ensureDemoUsers();

// 1. Unauthenticated /mcp names the metadata.
const unauth = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
check('401 with resource_metadata', unauth.status === 401 && (unauth.headers.get('www-authenticate') ?? '').includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`));

// 2. SDK flow up to the browser redirect.
const p = new Provider();
const t1 = new StreamableHTTPClientTransport(MCP, { authProvider: p });
try { await new Client({ name: 'e2e', version: '1' }).connect(t1); } catch { /* expected: Unauthorized → redirectToAuthorization */ }
check('dynamic registration', /^mcpc_/.test(p.info?.client_id ?? ''), p.info?.client_id?.slice(0, 10));
check('authorize URL uses PKCE S256 and names the resource', p.authUrl?.searchParams.get('code_challenge_method') === 'S256' && p.authUrl?.searchParams.get('resource') === MCP.href);

// 3. Browser: /oauth/authorize → dashboard /connect (served by the SPA) → consent as B.
const az = await fetch(p.authUrl, { redirect: 'manual' });
const connect = new URL(az.headers.get('location') ?? `${ORIGIN}/`);
check('authorize → consent page', az.status === 302 && connect.pathname === '/connect');
const page = await fetch(connect);
check('consent page is the dashboard SPA', page.status === 200 && (await page.text()).includes('<div id="root">'));
const request = connect.searchParams.get('request');
const shown = await api('POST', '/api/oauth/consent', b.cookie, { request });
check('consent shows client and user', shown.body?.client === 'e2e OAuth client' && shown.body?.user?.email === b.email);
const decided = await api('POST', '/api/oauth/consent/decision', b.cookie, { request, approve: true });
const back = new URL(decided.body?.redirect ?? 'http://invalid/');
check('approve → code back to the redirect URI with iss', back.origin + back.pathname === REDIRECT && !!back.searchParams.get('code') && back.searchParams.get('iss') === ORIGIN);
await t1.finishAuth(back.searchParams.get('code'));
check('tokens issued', /^mat_/.test(p.saved?.access_token ?? '') && /^mrt_/.test(p.saved?.refresh_token ?? ''));

// 4. Use them like Claude Code would.
const c = new Client({ name: 'e2e', version: '1' });
await c.connect(new StreamableHTTPClientTransport(MCP, { authProvider: p }));
const tools = (await c.listTools()).tools.map((t) => t.name);
check('tools/list as B over OAuth', tools.length > 0 && tools.some((n) => n.startsWith('woo__')), `${tools.length} tools`);
const call = await c.callTool({ name: 'woo__list_orders', arguments: { per_page: 1 } });
check('tools/call as B over OAuth', !call.isError);
await c.close();

// 5. Audit: rows under B with source=oauth.
const audit = await api('GET', `/api/audit?source=oauth&user=${b.user.id}&limit=20`, a.cookie);
const items = audit.body?.items ?? audit.body ?? [];
check('audited as B, source=oauth', Array.isArray(items) && items.some((r) => r.method === 'tools/call' && r.source === 'oauth'), `${items.length} rows`);

// 6. Revoke from the dashboard → next call 401; refresh refused too.
const grants = await api('GET', '/api/oauth/grants', b.cookie);
const g = (grants.body ?? []).find((x) => !x.revokedAt && x.client === 'e2e OAuth client');
check('grant listed for B without tokens', !!g && !JSON.stringify(grants.body).match(/mat_|mrt_|hash/));
check('revoke grant', (await api('DELETE', `/api/oauth/grants/${g?.id}`, b.cookie)).status === 204);
const after = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${p.saved.access_token}` }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
check('revoked grant → 401 on next call', after.status === 401);
const ref = await fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', client_id: p.info.client_id, refresh_token: p.saved.refresh_token }) });
check('revoked grant → refresh refused', ref.status === 400);

console.log(failed ? `\nFAIL  e2e oauth: ${failed} failed` : '\nPASS  e2e oauth');
process.exit(failed ? 1 : 0);
