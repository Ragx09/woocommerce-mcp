// UI-15: short-lived internal token for the dashboard chat agent. The agent is an MCP client of the
// gateway's own /mcp, so its calls take the same auth, routing and audit path as external clients, but
// attributed to the signed-in user with source=chat (REQ-GW-11, REQ-CHAT-03).
//
// Format: `itk_<base64url(JSON {sub, src, exp})>.<base64url(HMAC-SHA256(key, payload part))>`.
// - The HMAC key is 32 random bytes made at process start and never stored or sent anywhere. The agent
//   talks to its own process over loopback, so no other replica ever has to verify one of its tokens.
// - /mcp accepts these tokens only on a loopback connection (see `mcpAuthenticator`): a token that leaks
//   is useless through the Ingress.
// - Verifying the signature is not enough: the user is looked up on every request, so a user who is
//   disabled mid-conversation loses the chat's tool access at the next call, like an API key.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { authenticateApiKey, type Principal } from './api-keys.js';

export const INTERNAL_TOKEN_TTL_MS = 5 * 60_000;
const PREFIX = 'itk_';
const TOKEN_RE = /^itk_([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Payload { sub: string; src: 'chat'; exp: number }

export class InternalTokenSigner {
  readonly #key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    if (key.length < 32) throw new Error('internal token key must be at least 32 bytes');
    this.#key = key;
  }

  #sign(payloadPart: string): string {
    return createHmac('sha256', this.#key).update(payloadPart).digest('base64url');
  }

  /** A token for `userId`, valid for `ttlMs` (at most 5 min). */
  mint(userId: string, now = Date.now(), ttlMs = INTERNAL_TOKEN_TTL_MS): string {
    if (!UUID_RE.test(userId)) throw new Error('userId must be a UUID');
    if (!(ttlMs > 0 && ttlMs <= INTERNAL_TOKEN_TTL_MS)) throw new Error(`ttlMs must be in (0, ${INTERNAL_TOKEN_TTL_MS}]`);
    const payload: Payload = { sub: userId, src: 'chat', exp: now + ttlMs };
    const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${PREFIX}${part}.${this.#sign(part)}`;
  }

  /** The user id in a valid, unexpired token, or null. Never throws on client input. */
  verify(token: string, now = Date.now()): string | null {
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    const [, part, sig] = m as unknown as [string, string, string];
    const expected = Buffer.from(this.#sign(part));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let p: Partial<Payload>;
    try { p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Partial<Payload>; } catch { return null; }
    if (p.src !== 'chat' || typeof p.sub !== 'string' || !UUID_RE.test(p.sub)) return null;
    if (typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= now) return null;
    return p.sub;
  }
}

export const isInternalToken = (bearer: string): boolean => bearer.startsWith(PREFIX);

/** The principal behind an internal token, or null (bad/expired token, unknown or disabled user). */
export async function authenticateInternalToken(db: Db, signer: InternalTokenSigner, token: string): Promise<Principal | null> {
  const userId = signer.verify(token);
  if (!userId) return null;
  const [row] = await db.select({ userId: users.id, role: users.role, email: users.email })
    .from(users).where(and(eq(users.id, userId), isNull(users.disabledAt)));
  return row ? { ...row, keyId: null, source: 'chat' } : null;
}

/** Remote address of the TCP connection itself (not X-Forwarded-For): loopback means this pod. */
export function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

/** /mcp authentication: API keys from anywhere, internal chat tokens only over loopback. */
export function mcpAuthenticator(db: Db, signer: InternalTokenSigner) {
  return async (bearer: string, conn: { loopback: boolean }): Promise<Principal | null> => {
    if (isInternalToken(bearer)) return conn.loopback ? authenticateInternalToken(db, signer, bearer) : null;
    return authenticateApiKey(db, bearer);
  };
}
