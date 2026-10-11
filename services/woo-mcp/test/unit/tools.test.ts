// Tools exercised through a real MCP client/server pair (in-memory transport) against a fake WooCommerce.
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../src/config.js';
import { registerTools, storeDate } from '../../src/tools.js';
import { WooClient } from '../../src/woo-client.js';

const cfg: Config = {
  port: 0, wooBaseUrl: 'http://wordpress.store.svc', wooSigningUrl: 'http://store.example.test',
  wooConsumerKey: 'ck_SECRETKEY', wooConsumerSecret: 'cs_SECRETSECRET', wooTimeoutMs: 200, mcpAuthToken: 't', logLevel: 'silent',
};

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const order = (id: number, status = 'processing') => ({
  id, number: String(id), status, currency: 'USD', total: '17.00', date_created: '2026-10-11T09:30:00',
  billing: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', city: 'London', country: 'GB', phone: '+44 1' },
  shipping: {}, line_items: [{ name: 'Urumi Mug', quantity: 1, total: '12.00', product_id: 10 }],
  payment_method_title: 'Cash on delivery', customer_note: '', shipping_total: '5.00', total_tax: '0.00', discount_total: '0.00',
  date_paid: null, transaction_id: 'txn_should_not_leak', meta_data: [{ key: '_payment_token', value: 'tok_should_not_leak' }],
});

let calls: { method: string; url: URL; body?: unknown }[] = [];
let client: Client;

async function connect(route: Route, now = () => new Date('2026-10-11T20:00:00Z')) {
  calls = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(url, init);
  }) as typeof fetch;
  const server = new McpServer({ name: 'woo-mcp', version: 'test' });
  registerTools(server, new WooClient(cfg, fakeFetch), now);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
}
const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[])[0]!.text;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: text(r) };
};

afterEach(async () => { await client?.close(); });

describe('woo-mcp tools', () => {
  it('TC-WC-07-unit lists exactly the five tools with input schemas', async () => {
    await connect(() => reply(200, []));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_product', 'get_order', 'list_orders', 'list_products', 'update_order_status']);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('list_products maps products and sends a signed request to the internal URL', async () => {
    await connect(() => reply(200, [{ id: 10, name: 'Urumi Mug', status: 'publish', price: '12.00', regular_price: '12.00', sale_price: '', stock_status: 'instock', stock_quantity: null, permalink: 'http://store.example.test/product/urumi-mug/', sku: '' }]));
    const r = await call('list_products', { search: 'mug' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ count: 1, page: 1, products: [{ id: 10, name: 'Urumi Mug', status: 'publish', price: '12.00', regular_price: '12.00', stock_status: 'instock', permalink: 'http://store.example.test/product/urumi-mug/' }] });
    const u = calls[0]!.url;
    expect(u.origin + u.pathname).toBe('http://wordpress.store.svc/wp-json/wc/v3/products');
    expect(u.searchParams.get('search')).toBe('mug');
    expect(u.searchParams.get('oauth_signature_method')).toBe('HMAC-SHA256');
    expect(u.searchParams.get('oauth_signature')).toBeTruthy();
  });

  it('create_product posts a simple product and enables stock management only when asked', async () => {
    await connect((_u, init) => reply(201, { id: 42, ...JSON.parse(String(init.body)), price: '9.50', sale_price: '', stock_status: 'instock', stock_quantity: 3, permalink: 'http://store.example.test/product/x/', sku: '' }));
    const r = await call('create_product', { name: 'Chat Hoodie', regular_price: '9.50', stock_quantity: 3 });
    expect(r.isError).toBe(false);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({ type: 'simple', name: 'Chat Hoodie', regular_price: '9.50', status: 'publish', manage_stock: true, stock_quantity: 3 });
    expect(JSON.parse(r.text)).toMatchObject({ id: 42, permalink: 'http://store.example.test/product/x/' });
  });

  it('TC-UNIT-07a rejects invalid input before calling the store', async () => {
    await connect(() => reply(200, {}));
    for (const [name, args] of [
      ['create_product', { name: 'X', regular_price: '12,50' }],
      ['create_product', { name: '', regular_price: '1.00' }],
      ['update_order_status', { order_id: 1, status: 'shipped' }],
      ['get_order', { order_id: -1 }],
      ['list_products', { per_page: 500 }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("list_orders date='today' uses the store timezone for the day boundaries", async () => {
    // 20:00 UTC on Oct 11 is already Oct 12 in Asia/Kolkata (UTC+5:30).
    await connect((u) => (u.pathname === '/wp-json/' ? reply(200, { timezone_string: 'Asia/Kolkata', gmt_offset: 5.5 }) : reply(200, [order(7)])));
    const r = await call('list_orders', { date: 'today', status: 'processing' });
    const sent = calls.find((c) => c.url.pathname.endsWith('/orders'))!.url.searchParams;
    expect(sent.get('after')).toBe('2026-10-12T00:00:00');
    expect(sent.get('before')).toBe('2026-10-12T23:59:59');
    expect(sent.get('status')).toBe('processing');
    expect(JSON.parse(r.text)).toEqual({ count: 1, date: '2026-10-12', orders: [{ id: 7, number: '7', status: 'processing', total: '17.00', currency: 'USD', date_created: '2026-10-11T09:30:00', customer: 'Ada Lovelace', items: '1× Urumi Mug' }] });
  });

  it('get_order returns detail without payment tokens, transaction ids or phone numbers', async () => {
    await connect(() => reply(200, order(7)));
    const r = await call('get_order', { order_id: 7 });
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/tok_should_not_leak|txn_should_not_leak|\+44/);
    expect(JSON.parse(r.text)).toMatchObject({ id: 7, customer_email: 'ada@example.test', ship_to: 'London, GB', payment_method: 'Cash on delivery' });
  });

  it('TC-WC-11-2 unknown order id → isError "Order … not found."', async () => {
    await connect(() => reply(404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' }));
    expect(await call('get_order', { order_id: 999999 })).toEqual({ isError: true, text: 'Order 999999 not found.' });
  });

  it('update_order_status reports previous and new status', async () => {
    await connect((_u, init) => reply(200, order(7, init.method === 'PUT' ? 'completed' : 'processing')));
    const r = await call('update_order_status', { order_id: 7, status: 'completed' });
    expect(JSON.parse(r.text)).toEqual({ id: 7, number: '7', previous_status: 'processing', status: 'completed' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
  });

  it('TC-UNIT-07b store errors become safe messages that never contain credentials or URLs', async () => {
    const cases: [Route, RegExp][] = [
      [() => reply(401, { code: 'woocommerce_rest_authentication_error', message: 'Invalid signature - provided signature does not match.' }), /rejected the MCP server credentials/],
      [() => reply(500, { message: '<b>Fatal</b> error' }), /HTTP 500: Fatal error/],
      [() => { throw new TypeError('fetch failed'); }, /unreachable/],
      // Hangs forever but, like real fetch, rejects when the timeout signal aborts.
      [(_u, init) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason))), /did not answer within 200 ms/],
    ];
    for (const [route, expected] of cases) {
      await connect(route);
      const r = await call('list_products', {});
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(expected);
      expect(r.text).not.toMatch(/ck_SECRETKEY|cs_SECRETSECRET|oauth_|wordpress\.store\.svc/);
      await client.close();
    }
  });
});

describe('storeDate', () => {
  const t = new Date('2026-10-11T20:00:00Z');
  it('uses the IANA zone when present', () => expect(storeDate(t, 'Asia/Kolkata', 0)).toBe('2026-10-12'));
  it('falls back to the numeric offset', () => expect(storeDate(t, '', -5)).toBe('2026-10-11'));
  it('handles UTC', () => expect(storeDate(t, 'UTC', 0)).toBe('2026-10-11'));
});
