#!/usr/bin/env node
// UI-19 / TC-E2E-03 + TC-E2E-04: the two DoD chat prompts with the real LLM on a running cluster.
//   1. "Create a product called Demo Candle <stamp> priced 499" → woo__create_product through the gateway,
//      the product page is live on the storefront (HTTP 200, name + exact price) and in the public Store API.
//      PRICE may have paise (e.g. 12.50): the store keeps two decimals, so the page, the Store API and the
//      order total must show the exact price, never a rounded one (SPEC A-09).
//   2. A guest orders that product on the storefront (scripts/e2e-checkout.sh, Cash on delivery).
//   3. "What orders came in today?" → woo__list_orders; the answer names the new order, and the call's
//      count matches the store database (MariaDB, read with kubectl).
//   4. Both chat calls are in the audit log under the admin with source=chat.
// Signs in as the seeded admin (password from the Secret, never printed). Creates one product and one order
// and keeps them (the demo product). Two LLM questions: about one minute of the Groq free tier.
// Usage: node scripts/chat-flow.mjs   Env: APP_ORIGIN, STORE_ORIGIN (nip.io defaults), PRICE (499), SKIP_ORDER=1
import { execFileSync } from 'node:child_process';
import { adminSession } from './lib/gateway-key.mjs';

const ORIGIN = process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io';
const STORE = process.env.STORE_ORIGIN ?? 'http://store.127.0.0.1.nip.io';
const stamp = new Date().toISOString().slice(5, 16).replace(/\D/g, ''); // MMDDHHMM, unique per run
const NAME = `Demo Candle ${stamp}`;
const PRICE = process.env.PRICE ?? '499';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`); return ok; };

const cookie = await adminSession();
const started = new Date();
const api = (method, path, body) => fetch(`${ORIGIN}${path}`, {
  method, headers: { origin: ORIGIN, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

/** One chat question; waits out one LLM rate limit (Groq free tier) and asks again. */
async function ask(q) {
  for (let attempt = 0; ; attempt++) {
    const t = Date.now();
    const res = await api('POST', '/api/chat', { messages: [{ role: 'user', content: q }] });
    const body = await res.json();
    console.log(`\n> ${q}\nHTTP ${res.status} in ${Date.now() - t} ms${body.stopped ? `, stopped=${body.stopped}` : ''}`);
    if (res.status === 429 && body.error === 'llm_rate_limited' && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 30, 90);
      console.log(`  LLM rate limit, waiting ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) { check(`chat answered "${q}"`, false, `${body.error}: ${body.message}`); return null; }
    for (const c of body.toolCalls) console.log(`  tool ${c.name} ${JSON.stringify(c.args)} → ${c.ok ? 'ok' : 'error'} (${c.ms} ms) ${c.resultPreview.slice(0, 160).replace(/\s+/g, ' ')}`);
    console.log(`  reply: ${body.reply.slice(0, 800)}`);
    return body;
  }
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const sql = (q) => execFileSync('kubectl', ['-n', 'store', 'exec', 'mariadb-0', '--', 'sh', '-c',
  `mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress -N -e '${q}'`], { encoding: 'utf8' }).trim();

// 1. Create the product through the chat.
const created = await ask(`Create a product called ${NAME} priced ${PRICE}`);
let product = null;
if (created) {
  const call = created.toolCalls.find((c) => c.name === 'woo__create_product' && c.ok);
  check('chat called woo__create_product through the gateway', Boolean(call), created.toolCalls.map((c) => c.name).join(', '));
  if (call) {
    check('arguments: the asked name and price', call.args.name === NAME && Number(call.args.regular_price) === Number(PRICE)
      && (call.args.status ?? 'publish') === 'publish', JSON.stringify(call.args));
    product = parse(call.resultPreview);
    check('tool result has the new product id and permalink', Boolean(product?.id && product?.permalink), call.resultPreview.slice(0, 120));
  }
  check('reply confirms the product', created.reply.replace(/\s/gu, ' ').includes(NAME) || (product && created.reply.includes(String(product.id))));
}
if (product) {
  const page = await fetch(product.permalink);
  const html = await page.text();
  check('product page live on the storefront', page.status === 200 && html.includes(NAME)
    && new RegExp(`currencySymbol[^>]*>[^<]*</span>\\s*${PRICE.replace('.', '\\.')}\\s*<`).test(html), `${page.status} ${product.permalink}`);
  const store = await (await fetch(`${STORE}/wp-json/wc/store/v1/products?search=${encodeURIComponent(NAME)}`)).json();
  const s = store.find?.((p) => p.id === product.id);
  check('public Store API lists it, published at the asked price', Boolean(s) && Number(s.prices.price) / 10 ** s.prices.currency_minor_unit === Number(PRICE),
    s ? `${s.prices.currency_code} ${s.prices.price}` : 'not found');
}

// 2. Order it by hand on the storefront (guest, Cash on delivery).
let orderId = null;
if (product && !process.env.SKIP_ORDER) {
  const slug = new URL(product.permalink).pathname.split('/').filter(Boolean).at(-1);
  try {
    const out = execFileSync('scripts/e2e-checkout.sh', { encoding: 'utf8', env: { ...process.env, PRODUCT_SLUG: slug } });
    orderId = /order placed: #(\d+)/.exec(out)?.[1] ?? null;
  } catch (e) { console.log(String(e.stdout ?? '') + String(e.stderr ?? '')); }
  check('storefront order placed for the new product', Boolean(orderId), orderId ? `#${orderId}` : 'checkout failed');
  if (orderId) {
    const line = sql(`SELECT order_item_name FROM wp_woocommerce_order_items WHERE order_id=${Number(orderId)} AND order_item_type="line_item"`);
    check('the order contains the new product', line.split('\n').includes(NAME), line);
    const total = sql(`SELECT m.meta_value FROM wp_woocommerce_order_itemmeta m JOIN wp_woocommerce_order_items i USING (order_item_id) WHERE i.order_id=${Number(orderId)} AND i.order_item_type="line_item" AND m.meta_key="_line_total"`);
    check('the order line is charged the exact price (not rounded)', Number(total) === Number(PRICE), `line total ${total}`);
  }
}

// 3. Today's orders through the chat, against the store database.
const tz = sql('SELECT option_value FROM wp_options WHERE option_name="timezone_string"') || 'UTC';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dbIds = sql(`SELECT ID FROM wp_posts WHERE post_type="shop_order" AND post_status<>"trash" AND post_status<>"auto-draft" AND DATE(post_date)="${today}" ORDER BY ID DESC`)
  .split('\n').filter(Boolean);
console.log(`\nstore database: ${dbIds.length} order(s) on ${today} (${tz}): ${dbIds.map((i) => `#${i}`).join(', ') || 'none'}`);
const orders = await ask('What orders came in today?');
if (orders) {
  const call = orders.toolCalls.find((c) => c.name === 'woo__list_orders' && c.ok);
  check('chat called woo__list_orders', Boolean(call), orders.toolCalls.map((c) => c.name).join(', '));
  const res = call && parse(call.resultPreview);
  if (res) check("the tool's count matches the store database", res.count === dbIds.length, `tool ${res.count}, db ${dbIds.length}`);
  else if (call) console.log('  (result excerpt cut off at 500 chars; count not compared)');
  if (orderId) check('the answer names the new order', new RegExp(`#?\\b${orderId}\\b`).test(orders.reply), `#${orderId}`);
  else check('the answer reflects the database', dbIds.length === 0 ? /no orders|0 orders|none/i.test(orders.reply) : dbIds.every((i) => orders.reply.includes(i)));
}

// 4. The audit log has both calls under the admin, from the chat.
const me = await (await api('GET', '/api/me')).json();
const audit = await (await api('GET', `/api/audit?source=chat&from=${encodeURIComponent(started.toISOString())}&limit=100`)).json();
const rows = audit.items.filter((r) => r.method === 'tools/call');
const has = (tool) => rows.some((r) => r.tool === tool && r.upstream === 'woo' && r.user?.id === me.id && r.outcome === 'ok');
check('audit: create_product and list_orders under the admin with source=chat', has('create_product') && has('list_orders')
  && rows.every((r) => r.user?.id === me.id), `${rows.length} chat tool calls since start`);

const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAIL  UI-19 chat flow (${failed} of ${results.length})` : `\nPASS  UI-19 chat flow (${results.length}/${results.length}): ${NAME}${product ? ` id ${product.id}` : ''}${orderId ? `, order #${orderId}` : ''}`);
process.exit(failed ? 1 : 0);
