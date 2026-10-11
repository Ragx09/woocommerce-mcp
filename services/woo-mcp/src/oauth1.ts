// OAuth 1.0a one-legged signing exactly as WooCommerce verifies it
// (WC_REST_Authentication::check_oauth_signature, verified against WooCommerce 11.2.1 in ARC-14):
//  1. The base URI is the site's *home URL* + route, not the host the request was sent to.
//  2. Params are sorted by raw key (strcmp) before encoding; each "enc(k)=enc(v)" pair is
//     encoded again and pairs are joined with "%26".
//  3. Keep parameter names plain ([a-z0-9_]): PHP rewrites spaces, dots and "+" in $_GET keys.
import { createHmac, randomBytes } from 'node:crypto';

export type QueryValue = string | number | boolean;

/** RFC 3986 encoding (PHP rawurlencode): encodeURIComponent plus !'()*. */
export const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export interface SignInput {
  method: string;
  signingUrl: string;
  route: string;
  query?: Record<string, QueryValue | undefined>;
  key: string;
  secret: string;
  nowMs?: number;
  nonce?: string;
}

export function signatureBaseString(method: string, signingUrl: string, route: string, params: Record<string, string>): string {
  const pairs = Object.keys(params)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((k) => rfc3986(`${rfc3986(k)}=${rfc3986(params[k] as string)}`))
    .join('%26');
  return `${method.toUpperCase()}&${rfc3986(signingUrl.replace(/\/+$/, '') + route)}&${pairs}`;
}

/** Returns all query parameters (caller's + oauth_*) including oauth_signature. */
export function signParams(input: SignInput): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) params[k] = String(v);
  params.oauth_consumer_key = input.key;
  params.oauth_nonce = input.nonce ?? randomBytes(16).toString('hex');
  params.oauth_signature_method = 'HMAC-SHA256';
  params.oauth_timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const base = signatureBaseString(input.method, input.signingUrl, input.route, params);
  // One-legged OAuth: no token secret, so the HMAC key is "consumer_secret&".
  params.oauth_signature = createHmac('sha256', `${input.secret}&`).update(base).digest('base64');
  return params;
}
