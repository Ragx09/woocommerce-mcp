// BON-08: OAuth 2.1 for /mcp, following the MCP authorization spec (2025-11-25; SDK 1.32 LATEST_PROTOCOL_VERSION).
// The gateway is both the protected resource (/mcp) and its own authorization server (D-027):
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 metadata (the 401 from /mcp points here)
//   GET  /.well-known/oauth-authorization-server       RFC 8414 metadata
//   POST /oauth/register                               RFC 7591 dynamic registration (public clients only)
//   GET  /oauth/authorize                              code flow, PKCE S256 only → dashboard consent page
//   POST /oauth/token                                  authorization_code | refresh_token (rotated)
//   POST /oauth/revoke                                 RFC 7009
// Consent happens in the dashboard (/connect) with the normal session; the decision is a same-origin /api POST,
// so the existing CSRF defences (SameSite=Strict + Origin check) protect it. Before the client and its
// redirect URI are validated, errors are shown as text and never redirected (no open redirect).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import type { RateLimiter } from '../ratelimit.js';
import {
  CHALLENGE_RE, createRequest, decideRequest, describeRequest, exchangeCode, findClient, listGrants, OAuthError, purgeExpired,
  refresh, registerClient, revokeByToken, revokeGrantAs, SCOPE,
} from './store.js';

export interface OAuthDeps {
  db: Db;
  /** Public origin (issuer), e.g. https://app.example.com. */
  issuer: string;
  limiter: RateLimiter;
  /** Per client IP: registrations per hour, token/revoke and authorize requests per minute. */
  limits?: { registerPerHour: number; tokenPerMinute: number; authorizePerMinute: number };
}

const DEFAULT_LIMITS = { registerPerHour: 20, tokenPerMinute: 60, authorizePerMinute: 60 };

/** The protected resource identifier: the /mcp URL on the public origin (RFC 8707). */
export const resourceFor = (issuer: string): string => `${issuer}/mcp`;
export const resourceMetadataUrl = (issuer: string): string => `${issuer}/.well-known/oauth-protected-resource/mcp`;

// No cookies are read or set on these endpoints, so any origin may call them (browser-based MCP clients).
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

const oauthFail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof OAuthError) return reply.code(e.status).headers(CORS).send({ error: e.code, error_description: e.message });
  throw e;
};

/** One value per parameter (RFC 6749 §3.1: parameters must not be repeated). */
function single(body: unknown, name: string): string | null {
  const v = (body as Record<string, unknown> | null)?.[name];
  if (v === undefined) return null;
  if (typeof v !== 'string') throw new OAuthError('invalid_request', `parameter ${name} must be given once`);
  return v;
}

async function limited(deps: OAuthDeps, req: FastifyRequest, reply: FastifyReply, bucket: string, limit: number, windowMs: number): Promise<boolean> {
  const r = await deps.limiter.hit(`oauth:${bucket}:${req.ip}`, limit, windowMs);
  if (r.allowed) return false;
  reply.code(429).header('retry-after', String(r.retryAfterS)).headers(CORS).send({ error: 'slow_down', error_description: `too many requests; retry in ${r.retryAfterS} s` });
  return true;
}

export function registerOAuth(app: FastifyInstance, deps: OAuthDeps): void {
  const { db, issuer } = deps;
  const resource = resourceFor(issuer);
  const lim = deps.limits ?? DEFAULT_LIMITS;

  const resourceMetadata = { resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'MCP Gateway' };
  for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(url, async (_req, reply) => reply.headers(CORS).send(resourceMetadata));
  }
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => reply.headers(CORS).send({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  }));

  // Form posts (token, revoke) and JSON (register) live in this encapsulated scope only.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8 * 1024 }, (_req, body, done) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of new URLSearchParams(body as string)) {
        const prev = out[k];
        out[k] = prev === undefined ? v : [prev].flat().concat(v);
      }
      done(null, out);
    });
    scope.options('/oauth/*', async (_req, reply) => reply.code(204).headers(CORS).send());

    scope.post('/oauth/register', { bodyLimit: 8 * 1024 }, async (req, reply) => {
      if (await limited(deps, req, reply, 'register', lim.registerPerHour, 60 * 60_000)) return reply;
      try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const uris = b.redirect_uris;
        if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be an array of strings');
        const method = b.token_endpoint_auth_method ?? 'none';
        if (method !== 'none') throw new OAuthError('invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported');
        const grants = (b.grant_types ?? ['authorization_code']) as unknown;
        if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
          throw new OAuthError('invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token');
        }
        const types = (b.response_types ?? ['code']) as unknown;
        if (!Array.isArray(types) || types.some((t) => t !== 'code')) throw new OAuthError('invalid_client_metadata', 'response_types may only contain code');
        const rawName = typeof b.client_name === 'string' ? b.client_name : 'MCP client';
        // Shown on the consent page: printable characters only, no control/bidi characters.
        const name = rawName.replace(/[\p{C}]/gu, '').trim().slice(0, 100) || 'MCP client';
        const client = await registerClient(db, name, uris as string[]);
        req.log.info({ clientId: client.clientId, redirects: client.redirectUris.length }, 'oauth client registered');
        return reply.code(201).headers(CORS).send({
          client_id: client.clientId, client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000), client_name: client.name,
          redirect_uris: client.redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          token_endpoint_auth_method: 'none', scope: SCOPE,
        });
      } catch (e) { return oauthFail(reply, e); }
    });

    scope.post('/oauth/token', async (req, reply) => {
      if (await limited(deps, req, reply, 'token', lim.tokenPerMinute, 60_000)) return reply;
      try {
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'use application/x-www-form-urlencoded');
        const grantType = single(req.body, 'grant_type');
        const client = await findClient(db, single(req.body, 'client_id') ?? '');
        if (!client) throw new OAuthError('invalid_client', 'unknown client_id', 401);
        const res = single(req.body, 'resource');
        let tokens;
        if (grantType === 'authorization_code') {
          tokens = await exchangeCode(db, { client, code: single(req.body, 'code') ?? '', redirectUri: single(req.body, 'redirect_uri') ?? '',
            verifier: single(req.body, 'code_verifier') ?? '', resource: res });
        } else if (grantType === 'refresh_token') {
          tokens = await refresh(db, { client, refreshToken: single(req.body, 'refresh_token') ?? '', resource: res });
        } else {
          throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
        }
        req.log.info({ clientId: client.clientId, grantType }, 'oauth tokens issued');
        void purgeExpired(db).catch(() => {});
        return reply.headers({ ...CORS, pragma: 'no-cache' }).send(tokens);
      } catch (e) {
        if (e instanceof OAuthError) req.log.warn({ code: e.code }, 'oauth token request refused');
        return oauthFail(reply, e);
      }
    });

    scope.post('/oauth/revoke', async (req, reply) => {
      if (await limited(deps, req, reply, 'token', lim.tokenPerMinute, 60_000)) return reply;
      try {
        const client = await findClient(db, single(req.body, 'client_id') ?? '');
        if (!client) throw new OAuthError('invalid_client', 'unknown client_id', 401);
        await revokeByToken(db, client, single(req.body, 'token') ?? '');
        return reply.code(200).headers(CORS).send({});
      } catch (e) { return oauthFail(reply, e); }
    });
  });

  // Authorization endpoint: validate, park the request, send the browser to the consent page.
  app.get<{ Querystring: Record<string, string | string[]> }>('/oauth/authorize', async (req, reply) => {
    const plain = (status: number, msg: string) => reply.code(status).type('text/plain; charset=utf-8').send(`Authorization request refused: ${msg}`);
    if (await limited(deps, req, reply, 'authorize', lim.authorizePerMinute, 60_000)) return reply;
    const q = req.query;
    let clientIdParam: string | null; let redirectUri: string | null;
    try { clientIdParam = single(q, 'client_id'); redirectUri = single(q, 'redirect_uri'); } catch { return plain(400, 'repeated parameter'); }
    const client = await findClient(db, clientIdParam ?? '');
    if (!client) return plain(400, 'unknown client_id');
    // Exact string match against a registered URI (OAuth 2.1 §4.1.1); only then may errors go back to it.
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return plain(400, 'redirect_uri is not registered for this client');
    let state: string | null = null;
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri!);
      u.searchParams.set('error', error); u.searchParams.set('error_description', description); u.searchParams.set('iss', issuer);
      if (state !== null) u.searchParams.set('state', state);
      return reply.redirect(u.toString(), 302);
    };
    try {
      state = single(q, 'state');
      if (state !== null && state.length > 512) return back('invalid_request', 'state too long');
      if (single(q, 'response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
      const challenge = single(q, 'code_challenge');
      if (single(q, 'code_challenge_method') !== 'S256' || !challenge || !CHALLENGE_RE.test(challenge)) {
        return back('invalid_request', 'PKCE with code_challenge_method S256 is required');
      }
      const requested = single(q, 'resource');
      if (requested !== null && requested !== resource) return back('invalid_target', `this server only issues tokens for ${resource}`);
      const scopes = (single(q, 'scope') ?? SCOPE).split(' ').filter(Boolean);
      if (scopes.some((s) => s !== SCOPE)) return back('invalid_scope', `only scope "${SCOPE}" is supported`);
      const id = await createRequest(db, { client, redirectUri, codeChallenge: challenge, state, resource, scope: SCOPE });
      return reply.redirect(`${issuer}/connect?request=${id}`, 302);
    } catch {
      return back('invalid_request', 'malformed authorization request');
    }
  });

  // ---- Dashboard side (session + CSRF checks from the /api policy) ----
  const requestBody = { type: 'object', required: ['request'], additionalProperties: false, properties: { request: { type: 'string', maxLength: 64 } } } as const;

  // POST, not GET: the request id stays out of URLs in access logs.
  app.post<{ Body: { request: string } }>('/api/oauth/consent', { config: { access: 'session' }, schema: { body: requestBody } }, async (req, reply) => {
    const r = await describeRequest(db, req.body.request);
    if (!r) return reply.code(404).send({ error: 'not_found', message: 'this sign-in request has expired or was already used; start again from your MCP client' });
    const u = new URL(r.redirectUri);
    return { client: r.clientName, redirectTo: `${u.protocol}//${u.host}`, scope: r.scope, resource: r.resource, user: { email: req.user!.email, name: req.user!.name } };
  });

  app.post<{ Body: { request: string; approve: boolean } }>('/api/oauth/consent/decision', {
    config: { access: 'session' },
    schema: { body: { type: 'object', required: ['request', 'approve'], additionalProperties: false,
      properties: { request: { type: 'string', maxLength: 64 }, approve: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const redirect = await decideRequest(db, req.body.request, req.user!.id, req.body.approve, issuer);
    if (!redirect) return reply.code(404).send({ error: 'not_found', message: 'this sign-in request has expired or was already used; start again from your MCP client' });
    req.log.info({ userId: req.user!.id, approved: req.body.approve }, 'oauth consent decided');
    return { redirect };
  });

  app.get<{ Querystring: { all?: string } }>('/api/oauth/grants', {
    config: { access: 'session' },
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { all: { type: 'string', enum: ['0', '1'] } } } },
  }, async (req, reply) => {
    if (req.query.all === '1' && req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'not allowed for your role' });
    return listGrants(db, req.query.all === '1' ? {} : { userId: req.user!.id });
  });

  app.delete<{ Params: { id: string } }>('/api/oauth/grants/:id', {
    config: { access: 'session' }, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    if (!(await revokeGrantAs(db, req.params.id, req.user!))) return reply.code(404).send({ error: 'not_found', message: 'grant not found' });
    req.log.info({ grantId: req.params.id, by: req.user!.id }, 'oauth grant revoked');
    return reply.code(204).send();
  });
}
