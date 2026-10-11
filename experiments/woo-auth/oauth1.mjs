// OAuth 1.0a one-legged signing exactly as WooCommerce verifies it
// (WC_REST_Authentication::check_oauth_signature, verified against WooCommerce 11.2.1):
//  1. The base URI is the site's *home URL* + route, not the host the request was sent to.
//  2. Params are sorted by raw key (strcmp) *before* encoding; each "enc(k)=enc(v)" pair is
//     encoded again and pairs are joined with "%26".
//  3. Keep parameter names plain ([a-z0-9_]): PHP rewrites spaces/dots/+ in $_GET keys.
import { createHmac, randomBytes } from 'node:crypto';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function signedUrl({ method, homeUrl, sendUrl, route, query = {}, key, secret, now = Date.now(), nonce }) {
  const oauth = {
    oauth_consumer_key: key,
    oauth_nonce: nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(now / 1000)),
  };
  const params = { ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])), ...oauth };
  const pairs = Object.keys(params)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((k) => enc(`${enc(k)}=${enc(params[k])}`))
    .join('%26');
  const base = `${method.toUpperCase()}&${enc(homeUrl.replace(/\/$/, '') + route)}&${pairs}`;
  // WooCommerce appends "&" to the secret (no token secret in one-legged OAuth).
  const signature = createHmac('sha256', `${secret}&`).update(base).digest('base64');
  const url = new URL(sendUrl.replace(/\/$/, '') + route);
  for (const [k, v] of Object.entries({ ...params, oauth_signature: signature })) url.searchParams.set(k, v);
  return url;
}
