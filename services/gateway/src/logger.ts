// pino options shared by the app and the tests. Redaction is the last line of defence (REQ-SEC, T-10):
// code should not log secrets in the first place, but if a header or field slips through it is censored.
// Two layers (GW-17):
//  1. by field name (pino `redact`): headers and well-known secret keys, at the top level and one level down;
//  2. by value (`scrubSecrets`): strings that look like a credential (Bearer tokens, GitHub PATs, our API
//     keys, WooCommerce REST keys) are masked wherever they appear — error messages, msg text, nested data.
// Tool arguments and results are never logged at info (see mcp/route.ts); at debug only argument *names*.
import { randomUUID } from 'node:crypto';
import type { LoggerOptions } from 'pino';

const CENSOR = '[redacted]';

/** Field names whose value is always a secret. */
const SECRET_KEYS = [
  'authorization', 'cookie', 'password', 'credential', 'credentialEnc', 'credential_enc', 'apiKey', 'api_key',
  'key', 'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'secret', 'clientSecret',
  'client_secret', 'consumerSecret', 'consumer_secret', 'pat', 'devKey', 'mcpDevKey', 'sessionSecret',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-internal-token"]',
  'req.headers["mcp-session-id"]',
  'res.headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.cookie',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
];

/**
 * Credential-shaped substrings. Each keeps a short, harmless prefix so a log reader can still tell what
 * kind of value was there. Ordered from most to least specific.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic tokens
  /\bmgw_[A-Za-z0-9_]{16,}/g, // our gateway API keys (dev key mgw_dev_…, AUTH-08 keys)
  /\b(ck|cs)_[a-f0-9]{32,}/g, // WooCommerce REST consumer key/secret
  /\bsk-[A-Za-z0-9_-]{16,}/g, // LLM provider keys (OpenAI-style)
  /\bgsk_[A-Za-z0-9]{16,}/g, // Groq keys
];

export function scrubString(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, scheme?: string) =>
      (scheme && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${CENSOR}` : `${m.slice(0, 4)}…${CENSOR}`));
  }
  return out;
}

/** Deep copy with every string scrubbed. Depth-limited so a cyclic or huge object cannot stall logging. */
export function scrubSecrets<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return scrubString(value) as T;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { type: value.name, message: scrubString(value.message), stack: value.stack && scrubString(value.stack) } as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1)) as T;
  // Only plain objects: request/response objects and the like must reach pino's serializers intact
  // (copying them turns `req` into {}); their serialized form carries method/url/status only.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v, depth + 1);
  return out as T;
}

/** Request ids are random (unique across replicas and restarts); a client-supplied id is never trusted. */
export const genReqId = (): string => randomUUID();

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { svc: 'gateway' },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    formatters: { log: (obj) => scrubSecrets(obj) },
    hooks: {
      // msg text and printf-style arguments
      logMethod(args, method) {
        method.apply(this, args.map((a) => (typeof a === 'string' ? scrubString(a) : a)) as Parameters<typeof method>);
      },
    },
  };
}
