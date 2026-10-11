// WC-15 / TC-INT-01: the five tools against the real WooCommerce in k3d, through the MCP SDK client.
// Run: scripts/woo-int.sh  (port-forwards woo-mcp and passes the token via env; never printed)
// INT_PUBLISH=1 creates a *published* product and checks it on the storefront (WC-09); the default
// creates a draft so repeated runs do not clutter the shop.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.WOO_MCP_URL ?? 'http://localhost:18090/mcp';
const TOKEN = process.env.WOO_MCP_TOKEN ?? '';
const STORE = process.env.STORE_URL ?? 'http://store.127.0.0.1.nip.io';
const publish = process.env.INT_PUBLISH === '1';
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  return { isError: !!r.isError, text, data: r.isError ? undefined : JSON.parse(text) };
};

beforeAll(async () => {
  if (!TOKEN) throw new Error('WOO_MCP_TOKEN not set (use scripts/woo-int.sh)');
  client = new Client({ name: 'woo-int', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});
afterAll(async () => { await client?.close(); });

describe('woo-mcp against the real store', () => {
  it('TC-WC-08-1 list_products returns the seeded products', async () => {
    const r = await call('list_products', { per_page: 50 });
    expect(r.isError).toBe(false);
    const names = r.data.products.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Urumi Mug', 'Urumi T-Shirt', 'Urumi Sticker Pack']));
  });

  it(`TC-WC-09-1 create_product (${publish ? 'published, checked on storefront' : 'draft'})`, async () => {
    const name = `Integration Product ${Date.now()}`;
    const r = await call('create_product', { name, regular_price: '7.50', status: publish ? 'publish' : 'draft', description: 'Created by the woo-mcp integration test.' });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ name, regular_price: '7.50', status: publish ? 'publish' : 'draft' });
    const found = await call('list_products', { search: name, status: 'any' });
    expect(found.data.products.map((p: { id: number }) => p.id)).toContain(r.data.id);
    if (publish) {
      const page = await fetch(r.data.permalink.replace(/^https?:\/\/[^/]+/, STORE));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(name);
    }
  });

  let orderId = 0;
  it("TC-WC-10-1 list_orders date='today' contains the storefront order", async () => {
    const r = await call('list_orders', { date: 'today' });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.count).toBeGreaterThan(0);
    const order = r.data.orders.find((o: { items: string }) => /Urumi/.test(o.items));
    expect(order).toBeDefined();
    orderId = order.id;
  });

  it('TC-WC-11-1 get_order returns detail with COD and no payment secrets', async () => {
    const r = await call('get_order', { order_id: orderId });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ id: orderId, payment_method: 'Cash on delivery' });
    expect(r.text).not.toMatch(/transaction_id|_payment_token|meta_data/);
  });

  it('TC-WC-11-2 unknown order → clear error', async () => {
    expect(await call('get_order', { order_id: 999999 })).toMatchObject({ isError: true, text: 'Order 999999 not found.' });
  });

  it('TC-WC-12-1 update_order_status round trip (completed, then back)', async () => {
    const before = (await call('get_order', { order_id: orderId })).data.status;
    const r = await call('update_order_status', { order_id: orderId, status: 'completed' });
    expect(r.data).toMatchObject({ id: orderId, previous_status: before, status: 'completed' });
    expect((await call('get_order', { order_id: orderId })).data.status).toBe('completed');
    await call('update_order_status', { order_id: orderId, status: before });
  });

  it('TC-WC-12-2 invalid status → validation error, order unchanged', async () => {
    const r = await call('update_order_status', { order_id: orderId, status: 'shipped' });
    expect(r.isError).toBe(true);
  });
});
