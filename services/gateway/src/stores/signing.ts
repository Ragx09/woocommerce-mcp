// D-026: provisioner → gateway calls are HMAC-SHA256 signed with a shared internal key (Secret
// provisioner-signing), on top of the NetworkPolicy that admits only the provisioner pod. The signature covers
// the time, method, path and a hash of the exact body bytes, so a captured request cannot be re-pointed at
// another store or replayed after the 60-second window. Every handler is idempotent, so a replay inside the
// window changes nothing. The same function exists in services/provisioner/src/signing.ts.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-platform-signature';
export const MAX_SKEW_S = 60;

export function loadSigningKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const hex = env.PROVISIONER_SIGNING_KEY?.trim();
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('PROVISIONER_SIGNING_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(hex, 'hex');
}

const mac = (key: Buffer, t: number, method: string, path: string, body: string) =>
  createHmac('sha256', key).update(`${t}\n${method.toUpperCase()}\n${path}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');

/** `t=<unix seconds>,v1=<hex>` for one request. */
export function sign(key: Buffer, method: string, path: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${mac(key, t, method, path, body)}`;
}

/** True only for a well-formed, fresh signature over exactly this method, path and body. */
export function verify(key: Buffer, header: string | undefined, method: string, path: string, body: string, now = Date.now()): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now / 1000 - t) > MAX_SKEW_S) return false;
  const expected = Buffer.from(mac(key, t, method, path, body), 'hex');
  const given = Buffer.from(m[2]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * BON-10 / D-029: hosted servers' secret environment is encrypted by the gateway and opened by the provisioner with
 * a key derived from the shared signing key (HKDF-SHA256, fixed label), so the provisioner never holds the
 * gateway's credentials key. Same function in services/provisioner/src/signing.ts.
 */
export function hostedEnvKey(signingKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', signingKey, Buffer.alloc(0), 'hosted-env-v1', 32));
}

/**
 * BON-12: a wp-admin password reset requested by an admin is sealed by the gateway and opened by the provisioner with
 * a key derived (HKDF, own label) from the shared signing key. Same function in services/provisioner/src/signing.ts.
 */
export function storeResetKey(signingKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', signingKey, Buffer.alloc(0), 'store-reset-v1', 32));
}
