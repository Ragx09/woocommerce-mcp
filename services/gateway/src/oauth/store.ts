// OAuth 2.1 storage and rules (BON-08, D-027). Everything secret is a 256-bit random value of which only the
// SHA-256 is stored (like sessions and API keys, D-008): client ids are public, request ids, codes, access
// and refresh tokens are not. Single use is an atomic `UPDATE … WHERE used_at IS NULL RETURNING`, so two
// replicas racing on one code or refresh token cannot both win.
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { oauthClients, oauthGrants, oauthRequests, oauthTokens, users, type OAuthClient, type Role } from '../db/schema.js';
import type { Principal } from '../auth/api-keys.js';
import { sha256Hex } from '../auth/tokens.js';

export const SCOPE = 'mcp';
export const REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 2 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_REDIRECT_URIS = 5;

const ACCESS_PREFIX = 'mat_';
const REFRESH_PREFIX = 'mrt_';
const CODE_PREFIX = 'mac_';
export const ACCESS_RE = /^mat_[A-Za-z0-9_-]{43}$/;
const TOUCH_EVERY_MS = 60_000;

const random = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

/** The RFC 7636 S256 transform of a verifier. */
export const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

/**
 * Redirect URI rules (OAuth 2.1 §2.3.1, RFC 8252 §7.3, RFC 9700 §4.1): an absolute URI without fragment or
 * credentials; https anywhere, or plain http only to a loopback address (native clients such as Claude Code
 * listen on 127.0.0.1). Private-use schemes (`com.example.app:/cb`) are allowed for native apps, but never
 * schemes a browser would run (`javascript:`, `data:`, `file:` …).
 */
export function redirectUriProblem(raw: string): string | null {
  if (raw.length > 2048) return 'redirect_uri too long';
  let u: URL;
  try { u = new URL(raw); } catch { return 'redirect_uri must be an absolute URI'; }
  if (u.hash || raw.includes('#')) return 'redirect_uri must not contain a fragment';
  if (u.username || u.password) return 'redirect_uri must not contain credentials';
  const scheme = u.protocol.slice(0, -1);
  if (scheme === 'https') return u.hostname ? null : 'redirect_uri needs a host';
  if (scheme === 'http') {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? null : 'http redirect_uri only to a loopback address (127.0.0.1, localhost, [::1])';
  }
  if (['javascript', 'data', 'file', 'blob', 'vbscript', 'about', 'ftp', 'ws', 'wss'].includes(scheme)) return `redirect_uri scheme ${scheme} not allowed`;
  // Private-use URI scheme: reverse-domain style with a dot (RFC 8252 §7.1).
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+$/.test(scheme) ? null : 'redirect_uri must be https, loopback http or a reverse-domain private-use scheme';
}

export async function registerClient(db: Db, name: string, redirectUris: string[]): Promise<OAuthClient> {
  if (redirectUris.length < 1 || redirectUris.length > MAX_REDIRECT_URIS) throw new OAuthError('invalid_redirect_uri', `1 to ${MAX_REDIRECT_URIS} redirect_uris required`);
  for (const r of redirectUris) {
    const problem = redirectUriProblem(r);
    if (problem) throw new OAuthError('invalid_redirect_uri', problem);
  }
  const [row] = await db.insert(oauthClients).values({ clientId: random('mcpc_'), name, redirectUris: [...new Set(redirectUris)] }).returning();
  return row!;
}

export async function findClient(db: Db, clientId: string): Promise<OAuthClient | null> {
  if (!/^mcpc_[A-Za-z0-9_-]{22,64}$/.test(clientId)) return null;
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}

export interface AuthorizeParams { client: OAuthClient; redirectUri: string; codeChallenge: string; state: string | null; resource: string; scope: string }

/** Stores a validated authorize request; returns the opaque id the consent page carries (never stored). */
export async function createRequest(db: Db, p: AuthorizeParams, now = new Date()): Promise<string> {
  const id = random('');
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, now)); // housekeeping
  await db.insert(oauthRequests).values({ idHash: sha256Hex(id), clientId: p.client.id, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge,
    state: p.state, resource: p.resource, scope: p.scope, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS) });
  return id;
}

/** What the consent page shows: the client's self-chosen name and where the browser will be sent. */
export async function describeRequest(db: Db, id: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const [row] = await db.select({ clientName: oauthClients.name, redirectUri: oauthRequests.redirectUri, scope: oauthRequests.scope, resource: oauthRequests.resource })
    .from(oauthRequests).innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientId))
    .where(and(eq(oauthRequests.idHash, sha256Hex(id)), gt(oauthRequests.expiresAt, now)));
  return row ?? null;
}

/** The URL the browser goes to after the decision: code (approve) or access_denied (deny), plus state and iss (RFC 9207). */
function callbackUrl(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * The signed-in user decides on a pending request. The request is consumed either way (one decision per
 * request). Approve → a grant and a 2-minute single-use code bound to the PKCE challenge and redirect URI.
 */
export async function decideRequest(db: Db, id: string, userId: string, approve: boolean, issuer: string, now = new Date()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  return db.transaction(async (tx) => {
    const [req] = await tx.delete(oauthRequests).where(and(eq(oauthRequests.idHash, sha256Hex(id)), gt(oauthRequests.expiresAt, now))).returning();
    if (!req) return null;
    if (!approve) return callbackUrl(req.redirectUri, { error: 'access_denied', error_description: 'the user denied access', state: req.state, iss: issuer });
    const [grant] = await tx.insert(oauthGrants).values({ userId, clientId: req.clientId, resource: req.resource, scope: req.scope }).returning({ id: oauthGrants.id });
    const code = random(CODE_PREFIX);
    await tx.insert(oauthTokens).values({ tokenHash: sha256Hex(code), grantId: grant!.id, kind: 'code', codeChallenge: req.codeChallenge,
      redirectUri: req.redirectUri, expiresAt: new Date(now.getTime() + CODE_TTL_MS) });
    return callbackUrl(req.redirectUri, { code, state: req.state, iss: issuer });
  });
}

export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

async function issuePair(tx: Pick<Db, 'insert'>, grantId: string, scope: string, now: Date): Promise<TokenResponse> {
  const access = random(ACCESS_PREFIX);
  const refresh = random(REFRESH_PREFIX);
  await tx.insert(oauthTokens).values([
    { tokenHash: sha256Hex(access), grantId, kind: 'access', expiresAt: new Date(now.getTime() + ACCESS_TTL_MS) },
    { tokenHash: sha256Hex(refresh), grantId, kind: 'refresh', expiresAt: new Date(now.getTime() + REFRESH_TTL_MS) },
  ]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope };
}

/** Ends a grant (idempotent: the first reason stays). */
export async function revokeGrant(db: Pick<Db, 'update'>, grantId: string, reason: 'user' | 'admin' | 'client' | 'replay', by: string | null = null): Promise<void> {
  await db.update(oauthGrants).set({ revokedAt: new Date(), revokedReason: reason, revokedBy: by })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
}

/**
 * Consumes a single-use token (code or refresh) for `client`. A second use of the same value means it was
 * stolen or replayed: the whole grant is revoked, so the attacker's and the client's tokens die together
 * (OAuth 2.1 §4.1.3, §4.3.1; RFC 9700 §4.14.2).
 */
async function consume(db: Db, kind: 'code' | 'refresh', value: string, client: OAuthClient, now: Date) {
  const hash = sha256Hex(value);
  const [row] = await db.select({ t: oauthTokens, g: oauthGrants }).from(oauthTokens).innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .where(and(eq(oauthTokens.tokenHash, hash), eq(oauthTokens.kind, kind)));
  const bad = new OAuthError('invalid_grant', kind === 'code' ? 'authorization code invalid, expired or already used' : 'refresh token invalid, expired or already used');
  if (!row || row.g.clientId !== client.id) throw bad;
  if (row.t.usedAt) { await revokeGrant(db, row.g.id, 'replay'); throw bad; }
  if (row.g.revokedAt || row.t.expiresAt <= now) throw bad;
  const [won] = await db.update(oauthTokens).set({ usedAt: now }).where(and(eq(oauthTokens.tokenHash, hash), isNull(oauthTokens.usedAt))).returning({ h: oauthTokens.tokenHash });
  if (!won) { await revokeGrant(db, row.g.id, 'replay'); throw bad; } // lost a race with another use of the same value
  return row;
}

async function ensureUserActive(db: Db, userId: string): Promise<void> {
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
  if (!u) throw new OAuthError('invalid_grant', 'the user of this grant is disabled');
}

export async function exchangeCode(db: Db, p: { client: OAuthClient; code: string; redirectUri: string; verifier: string; resource: string | null }, now = new Date()): Promise<TokenResponse> {
  const row = await consume(db, 'code', p.code, p.client, now);
  // Checked after consuming: a wrong verifier still burns the code (no guessing several verifiers on one code).
  if (row.t.redirectUri !== p.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!VERIFIER_RE.test(p.verifier) || s256(p.verifier) !== row.t.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE code_verifier does not match');
  if (p.resource !== null && p.resource !== row.g.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
  await ensureUserActive(db, row.g.userId);
  return db.transaction((tx) => issuePair(tx, row.g.id, row.g.scope, now));
}

export async function refresh(db: Db, p: { client: OAuthClient; refreshToken: string; resource: string | null }, now = new Date()): Promise<TokenResponse> {
  const row = await consume(db, 'refresh', p.refreshToken, p.client, now);
  if (p.resource !== null && p.resource !== row.g.resource) throw new OAuthError('invalid_target', 'resource does not match the grant');
  await ensureUserActive(db, row.g.userId);
  return db.transaction((tx) => issuePair(tx, row.g.id, row.g.scope, now));
}

/** RFC 7009: revoking any token of a grant ends the grant. Unknown tokens are not an error (no oracle). */
export async function revokeByToken(db: Db, client: OAuthClient, token: string): Promise<void> {
  if (token.length > 200) return;
  const [row] = await db.select({ grantId: oauthTokens.grantId, clientId: oauthGrants.clientId }).from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId)).where(eq(oauthTokens.tokenHash, sha256Hex(token)));
  if (row && row.clientId === client.id) await revokeGrant(db, row.grantId, 'client');
}

/**
 * /mcp: the principal behind an access token, or null. Looked up on every request (no cache), so a revoked
 * grant or a disabled user is refused on the next call; the token must have been issued for this resource.
 */
export async function authenticateAccessToken(db: Db, token: string, resource: string, now = new Date()): Promise<Principal | null> {
  if (!ACCESS_RE.test(token)) return null;
  const [row] = await db.select({ grantId: oauthGrants.id, resource: oauthGrants.resource, lastUsedAt: oauthGrants.lastUsedAt,
    userId: users.id, role: users.role, email: users.email })
    .from(oauthTokens).innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId)).innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthTokens.tokenHash, sha256Hex(token)), eq(oauthTokens.kind, 'access'), gt(oauthTokens.expiresAt, now),
      isNull(oauthGrants.revokedAt), isNull(users.disabledAt)));
  if (!row || row.resource !== resource) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, row.grantId));
  }
  return { userId: row.userId, keyId: null, role: row.role as Role, email: row.email, source: 'oauth', grantId: row.grantId };
}

export const isAccessToken = (bearer: string): boolean => bearer.startsWith(ACCESS_PREFIX);

/** Grants for the dashboard: own, or everyone's for an admin. Never a token. */
export async function listGrants(db: Db, opts: { userId?: string }) {
  return db.select({ id: oauthGrants.id, client: oauthClients.name, createdAt: oauthGrants.createdAt, lastUsedAt: oauthGrants.lastUsedAt,
    revokedAt: oauthGrants.revokedAt, revokedReason: oauthGrants.revokedReason,
    owner: { id: users.id, email: users.email, name: users.name } })
    .from(oauthGrants).innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId)).innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(opts.userId ? eq(oauthGrants.userId, opts.userId) : undefined)
    .orderBy(desc(oauthGrants.createdAt)).limit(200);
}

/** Owner or admin; anyone else gets "not found" so grant ids cannot be probed. */
export async function revokeGrantAs(db: Db, grantId: string, by: { id: string; role: Role }): Promise<boolean> {
  const [g] = await db.select({ userId: oauthGrants.userId }).from(oauthGrants).where(eq(oauthGrants.id, grantId));
  if (!g || (by.role !== 'admin' && g.userId !== by.id)) return false;
  await revokeGrant(db, grantId, g.userId === by.id ? 'user' : 'admin', by.id);
  return true;
}

/** Housekeeping: expired codes/tokens (bounded per call). */
export async function purgeExpired(db: Db, now = new Date()): Promise<void> {
  await db.execute(sql`DELETE FROM oauth_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_tokens WHERE expires_at < ${now} LIMIT 1000)`);
}
