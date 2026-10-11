// ARC-14 smoke: signed WooCommerce REST calls over plain HTTP.
// Usage: KEYS_FILE=<file with WOO_CONSUMER_KEY=/WOO_CONSUMER_SECRET= lines> node smoke.mjs
import { readFileSync } from 'node:fs';
import { signedUrl } from './oauth1.mjs';

const env = Object.fromEntries(readFileSync(process.env.KEYS_FILE, 'utf8').split('\n')
  .filter((l) => l.startsWith('WOO_CONSUMER_')).map((l) => l.split('=')));
const base = {
  homeUrl: process.env.HOME_URL ?? 'http://shop.arc14.test', // WordPress "home" option
  sendUrl: process.env.SEND_URL ?? 'http://localhost:8088',   // where we actually connect
  key: env.WOO_CONSUMER_KEY, secret: env.WOO_CONSUMER_SECRET,
};
let failed = 0;
async function check(name, expectStatus, opts, body) {
  const url = signedUrl({ ...base, ...opts });
  const res = await fetch(url, {
    method: opts.method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  const ok = res.status === expectStatus;
  if (!ok) failed++;
  const detail = Array.isArray(json) ? `${json.length} items: ${json.map((p) => p.name).join(', ')}`
    : json?.code ?? (json?.id ? `id=${json.id} name=${json.name}` : '');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: HTTP ${res.status} (want ${expectStatus}) ${detail}`);
  return json;
}

const route = '/wp-json/wc/v3/products';
await check('TC-ARC-14-1 signed GET products', 200, { method: 'GET', route, query: { per_page: 10 } });
await check('encoding: several plain params incl. _fields with comma', 200, { method: 'GET', route, query: { search: 'Urumi T-Shirt', per_page: 5, orderby: 'title', order: 'asc', context: 'view', _fields: 'id,name' } });
await check('encoding: search "a b+c ~*é" (0 hits expected)', 200, { method: 'GET', route, query: { search: 'a b+c ~*é' } });
const created = await check('signed POST create product (JSON body)', 201, { method: 'POST', route }, { name: 'ARC14 Probe', regular_price: '1.00', status: 'draft' });
if (created?.id) await check('signed DELETE product', 200, { method: 'DELETE', route: `${route}/${created.id}`, query: { force: true } });
await check('TC-ARC-14-2 tampered secret', 401, { method: 'GET', route, secret: base.secret + 'x' });
await check('signed with request host instead of home URL', 401, { method: 'GET', route, homeUrl: base.sendUrl });
await check('unsigned request', 401, { method: 'GET', route, key: 'ck_invalid' });
process.exit(failed ? 1 : 0);
