// SEC-04: checkout price/quantity/coupon tampering through the public WooCommerce Store API (the same API the
// storefront's blocks use). One order is placed with tampered fields to prove the server recomputes the total
// and does not mark it paid; it is cancelled again afterwards through the gateway (admin key → woo-mcp).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoUsers, mcp, STORE, tempKey } from './lib.mjs';

const API = `${STORE}/wp-json/wc/store/v1`;
let product; // a purchasable simple product
let placedOrderId;

/** A fresh guest cart: every request carries its Cart-Token and Nonce. */
async function cart() {
  const res = await fetch(`${API}/cart`);
  const s = { token: res.headers.get('cart-token'), nonce: res.headers.get('nonce') };
  const call = async (method, path, body) => {
    const r = await fetch(`${API}${path}`, {
      method, headers: { 'cart-token': s.token, nonce: s.nonce, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html error page */ }
    return { status: r.status, body: json, text };
  };
  return call;
}

beforeAll(async () => {
  const list = await (await fetch(`${API}/products?per_page=50`)).json();
  product = list.find((p) => p.type === 'simple' && p.is_purchasable && p.is_in_stock && !/demo (mug|candle)/i.test(p.name));
  expect(product).toBeTruthy();
});

afterAll(async () => {
  if (!placedOrderId) return;
  const { a } = await demoUsers();
  const k = await tempKey(a.cookie, 'sec-test cancel order');
  try {
    const r = await mcp(k.key, 'tools/call', { name: 'woo__update_order_status', arguments: { order_id: placedOrderId, status: 'cancelled' } });
    if (r.body?.result?.isError || r.body?.error) console.warn(`could not cancel order ${placedOrderId}: ${r.text.slice(0, 200)}`);
  } finally { await k.revoke(); }
});

describe('TC-SEC-04-9 cart tampering', () => {
  it('a client-sent price is ignored: the line costs the catalogue price', async () => {
    const c = await cart();
    const r = await c('POST', '/cart/add-item', { id: product.id, quantity: 2, price: '1', prices: { price: '1' }, total: '0.01' });
    expect(r.status).toBe(201);
    const line = r.body.items.find((i) => i.id === product.id);
    expect(line.prices.price).toBe(product.prices.price);
    expect(Number(r.body.totals.total_items)).toBe(2 * Number(product.prices.price));
  });
  it.each([[0], [-1], [-100], [1.5], ['1e3'], [10_000_000]])('quantity %s is refused or clamped, never negative/fractional', async (q) => {
    const c = await cart();
    const r = await c('POST', '/cart/add-item', { id: product.id, quantity: q });
    if (r.status === 201) {
      const line = r.body.items.find((i) => i.id === product.id);
      expect(Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 9999).toBe(true);
      expect(Number(r.body.totals.total_price)).toBeGreaterThan(0);
    } else {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });
  it('update-item cannot set a negative quantity', async () => {
    const c = await cart();
    const added = await c('POST', '/cart/add-item', { id: product.id, quantity: 1 });
    const key = added.body.items[0].key;
    const r = await c('POST', '/cart/update-item', { key, quantity: -5 });
    if (r.status < 300) expect(r.body.items.every((i) => i.quantity >= 0)).toBe(true);
    else expect(r.status).toBeLessThan(500);
    expect(Number((await c('GET', '/cart')).body.totals.total_price)).toBeGreaterThanOrEqual(0);
  });
  it.each(['FREE100', "' OR 1=1 --", '<script>x</script>', 'x'.repeat(500)])('coupon %s → refused, no discount', async (code) => {
    const c = await cart();
    await c('POST', '/cart/add-item', { id: product.id, quantity: 1 });
    const r = await c('POST', '/cart/apply-coupon', { code });
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/<script>x<\/script>/);
    expect(Number((await c('GET', '/cart')).body.totals.total_discount)).toBe(0);
  });
  it('trashed, draft or unknown products cannot be added', async () => {
    const c = await cart();
    for (const id of [121, 122, 123, 999999]) {
      const r = await c('POST', '/cart/add-item', { id, quantity: 1 });
      expect.soft(r.status, `product ${id}`).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('TC-SEC-04-10 checkout tampering', () => {
  const address = { first_name: 'Sec', last_name: 'Test', address_1: '1 Test Road', city: 'Bengaluru', state: 'KA', postcode: '560001', country: 'IN', email: 'sec-test@example.invalid', phone: '9000000000' };
  it('a payment method that is not enabled is refused, no order', async () => {
    const c = await cart();
    await c('POST', '/cart/add-item', { id: product.id, quantity: 1 });
    const r = await c('POST', '/checkout', { billing_address: address, shipping_address: address, payment_method: 'bacs' });
    expect(r.status).toBe(400);
  });
  it('tampered totals/status/paid flags are ignored: server total, not paid', async () => {
    const c = await cart();
    await c('POST', '/cart/add-item', { id: product.id, quantity: 1 });
    const expected = Number((await c('GET', '/cart')).body.totals.total_price);
    const r = await c('POST', '/checkout', {
      billing_address: address, shipping_address: address, payment_method: 'cod', customer_note: 'SEC-04 tamper test (auto-cancelled)',
      total: '1', totals: { total_price: '1' }, status: 'completed', set_paid: true, date_paid: '2026-01-01', customer_id: 1,
      payment_data: [{ key: 'transaction_id', value: 'forged' }, { key: 'paid', value: 'yes' }],
    });
    expect(r.status).toBe(200);
    placedOrderId = r.body.order_id;
    expect(placedOrderId).toBeGreaterThan(0);
    expect(r.body.status).not.toBe('completed');
    expect(r.body.payment_result.payment_status).not.toBe('success-paid');
    // The order as WooCommerce stored it, read with an admin key through the gateway.
    const { a } = await demoUsers();
    const k = await tempKey(a.cookie, 'sec-test read order');
    try {
      const o = await mcp(k.key, 'tools/call', { name: 'woo__get_order', arguments: { order_id: placedOrderId } });
      const text = o.body.result.content.map((x) => x.text ?? '').join('\n');
      const total = Number(JSON.parse(text).total ?? NaN) * 10 ** product.prices.currency_minor_unit;
      expect(total).toBe(expected);
      expect(text).not.toMatch(/"status":\s*"completed"/);
      expect(text).not.toMatch(/forged/);
    } finally { await k.revoke(); }
  });
});
