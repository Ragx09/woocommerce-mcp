// The six WooCommerce tools. Inputs are validated by zod (via the MCP SDK); outputs are compact
// summaries so the LLM gets what it needs without raw WooCommerce payloads or payment details.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WooClient, WooError } from './woo-client.js';
import { ImageUrlError, validateImageUrl } from './image-url.js';

export const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;
const PRODUCT_STATUSES = ['publish', 'draft', 'pending', 'private'] as const;

// ---- WooCommerce payload shapes (only the fields we read) ----
interface WcProduct {
  id: number; name: string; status: string; price: string; regular_price: string; sale_price: string;
  stock_status: string; stock_quantity: number | null; permalink: string; sku: string; images?: { src: string }[];
}
interface WcLineItem { name: string; quantity: number; total: string; product_id: number }
interface WcAddress { first_name?: string; last_name?: string; email?: string; city?: string; country?: string }
interface WcOrder {
  id: number; number: string; status: string; currency: string; total: string; date_created: string;
  billing: WcAddress; shipping: WcAddress; line_items: WcLineItem[]; payment_method_title: string;
  customer_note: string; shipping_total: string; total_tax: string; discount_total: string; date_paid: string | null;
}

export const product = (p: WcProduct) => ({
  id: p.id, name: p.name, status: p.status, price: p.price, regular_price: p.regular_price,
  sale_price: p.sale_price || undefined, sku: p.sku || undefined,
  stock_status: p.stock_status, stock_quantity: p.stock_quantity ?? undefined, permalink: p.permalink,
  image: p.images?.[0]?.src || undefined,
});
const customerName = (o: WcOrder) => [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' ') || 'Guest';
export const orderSummary = (o: WcOrder) => ({
  id: o.id, number: o.number, status: o.status, total: o.total, currency: o.currency, date_created: o.date_created,
  customer: customerName(o), items: o.line_items.map((li) => `${li.quantity}× ${li.name}`).join(', '),
});
// Order detail: no payment tokens, no transaction ids, no full addresses or phone numbers.
export const orderDetail = (o: WcOrder) => ({
  ...orderSummary(o),
  date_paid: o.date_paid, payment_method: o.payment_method_title,
  customer_email: o.billing?.email || undefined,
  ship_to: [o.shipping?.city || o.billing?.city, o.shipping?.country || o.billing?.country].filter(Boolean).join(', ') || undefined,
  customer_note: o.customer_note || undefined,
  totals: { shipping: o.shipping_total, tax: o.total_tax, discount: o.discount_total, total: o.total },
  line_items: o.line_items.map((li) => ({ product_id: li.product_id, name: li.name, quantity: li.quantity, total: li.total })),
});

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Local calendar date (YYYY-MM-DD) in the store's timezone. */
export function storeDate(now: Date, timezone: string, gmtOffsetHours: number): string {
  if (timezone && timezone !== 'UTC' && !/^UTC[+-]/.test(timezone)) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
    catch { /* unknown zone name: fall back to the numeric offset */ }
  }
  return new Date(now.getTime() + gmtOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

type Handler<A> = (args: A) => Promise<CallToolResult>;
/** Converts WooErrors (and anything unexpected) into safe isError results. */
function safe<A>(onError: (e: WooError, args: A) => string | undefined, fn: (args: A) => Promise<unknown>): Handler<A> {
  return async (args) => {
    try { return ok(await fn(args)); }
    catch (e) {
      if (e instanceof WooError) return fail(onError(e, args) ?? e.message);
      return fail('Internal error in the WooCommerce MCP server.');
    }
  };
}
const noOverride = () => undefined;
const price = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'decimal string such as "19.99"');
const imageUrl = z.string().max(2048).optional().describe('Public https URL of a .jpg/.jpeg/.png/.gif/.webp image; WooCommerce downloads it as the product image');
const imageAlt = z.string().max(200).optional().describe('Alt text for the image, describing what is visible');
const imageError = (e: WooError) => (e.kind === 'invalid_request' ? e.message : undefined);
/** The `images` field for a create/update body; the URL is checked before WooCommerce is asked to fetch it. */
async function imagesField(a: { image_url?: string; image_alt?: string }): Promise<{ images?: { src: string; alt?: string }[] }> {
  if (a.image_url === undefined) return {};
  try { return { images: [{ src: await validateImageUrl(a.image_url), ...(a.image_alt ? { alt: a.image_alt } : {}) }] }; }
  catch (e) {
    if (e instanceof ImageUrlError) throw new WooError('invalid_request', e.message, 400);
    throw e;
  }
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS');

export function registerTools(server: McpServer, woo: WooClient, now: () => Date = () => new Date()): void {
  server.registerTool('list_products', {
    title: 'List products',
    description: 'List products in the WooCommerce store, optionally filtered by a search term.',
    inputSchema: {
      search: z.string().max(100).optional().describe('Text to search for in product names and descriptions'),
      status: z.enum([...PRODUCT_STATUSES, 'any']).default('any').describe('Product status filter'),
      per_page: z.number().int().min(1).max(50).default(20),
      page: z.number().int().min(1).max(1000).default(1),
    },
    annotations: { readOnlyHint: true },
  }, safe(noOverride, async (a) => {
    const items = await woo.request<WcProduct[]>('GET', '/products', { query: { search: a.search, status: a.status, per_page: a.per_page, page: a.page } });
    return { count: items.length, page: a.page, products: items.map(product) };
  }));

  server.registerTool('create_product', {
    title: 'Create product',
    description: 'Create a simple product in the WooCommerce store. Published products appear on the storefront immediately.',
    inputSchema: {
      name: z.string().trim().min(1).max(200),
      regular_price: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'decimal string such as "19.99"').describe('Price as a decimal string, e.g. "19.99"'),
      description: z.string().max(5000).optional(),
      short_description: z.string().max(1000).optional(),
      sku: z.string().max(100).optional(),
      stock_quantity: z.number().int().min(0).max(1_000_000).optional().describe('Enables stock management when set'),
      status: z.enum(PRODUCT_STATUSES).default('publish'),
      image_url: imageUrl,
      image_alt: imageAlt,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, safe(imageError, async (a) => {
    const body = {
      type: 'simple', name: a.name, regular_price: a.regular_price, status: a.status,
      description: a.description, short_description: a.short_description, sku: a.sku,
      ...(a.stock_quantity === undefined ? {} : { manage_stock: true, stock_quantity: a.stock_quantity }),
      ...(await imagesField(a)),
    };
    return product(await woo.request<WcProduct>('POST', '/products', { body }));
  }));

  server.registerTool('update_product', {
    title: 'Update product',
    description: 'Change fields of an existing product (only the fields you pass). image_url replaces the product image: WooCommerce downloads it into the media library.',
    inputSchema: {
      product_id: z.number().int().positive(),
      name: z.string().trim().min(1).max(200).optional(),
      regular_price: price.optional(),
      sale_price: z.union([price, z.literal('')]).optional().describe('Empty string removes the sale price'),
      description: z.string().max(5000).optional(),
      short_description: z.string().max(1000).optional(),
      stock_quantity: z.number().int().min(0).max(1_000_000).optional().describe('Enables stock management when set'),
      status: z.enum(PRODUCT_STATUSES).optional(),
      image_url: imageUrl,
      image_alt: imageAlt,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, safe((e, a) => (e.kind === 'not_found' ? `Product ${a.product_id} not found.` : imageError(e)), async (a) => {
    const { product_id, image_url: _u, image_alt: _a, stock_quantity, ...fields } = a;
    const body = {
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      ...(stock_quantity === undefined ? {} : { manage_stock: true, stock_quantity }),
      ...(await imagesField(a)),
    };
    if (Object.keys(body).length === 0) throw new WooError('invalid_request', 'Nothing to update: pass at least one field to change.');
    return product(await woo.request<WcProduct>('PUT', `/products/${product_id}`, { body }));
  }));

  server.registerTool('list_orders', {
    title: 'List orders',
    description: "List orders, newest first. Use date='today' for today's orders in the store's timezone, or a YYYY-MM-DD date, or after/before for a range.",
    inputSchema: {
      status: z.enum([...ORDER_STATUSES, 'any']).default('any'),
      date: z.union([z.literal('today'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional().describe("'today' or a single day YYYY-MM-DD (store timezone)"),
      after: isoDate.optional().describe('Orders created after this store-local time'),
      before: isoDate.optional().describe('Orders created before this store-local time'),
      per_page: z.number().int().min(1).max(50).default(20),
      page: z.number().int().min(1).max(1000).default(1),
    },
    annotations: { readOnlyHint: true },
  }, safe(noOverride, async (a) => {
    let { after, before } = a;
    let day: string | undefined;
    if (a.date) {
      day = a.date === 'today' ? await woo.getStoreInfo().then((s) => storeDate(now(), s.timezone, s.gmtOffsetHours)) : a.date;
      after = `${day}T00:00:00`;
      before = `${day}T23:59:59`;
    }
    const items = await woo.request<WcOrder[]>('GET', '/orders', {
      query: { status: a.status, after, before, per_page: a.per_page, page: a.page, orderby: 'date', order: 'desc' },
    });
    return { count: items.length, ...(day ? { date: day } : {}), orders: items.map(orderSummary) };
  }));

  server.registerTool('get_order', {
    title: 'Get order',
    description: 'Get the details of one order by its id.',
    inputSchema: { order_id: z.number().int().positive() },
    annotations: { readOnlyHint: true },
  }, safe((e, a) => (e.kind === 'not_found' ? `Order ${a.order_id} not found.` : undefined), async (a) =>
    orderDetail(await woo.request<WcOrder>('GET', `/orders/${a.order_id}`))));

  server.registerTool('update_order_status', {
    title: 'Update order status',
    description: `Change the status of an order. Allowed statuses: ${ORDER_STATUSES.join(', ')}.`,
    inputSchema: { order_id: z.number().int().positive(), status: z.enum(ORDER_STATUSES) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, safe((e, a) => (e.kind === 'not_found' ? `Order ${a.order_id} not found.` : undefined), async (a) => {
    const before = await woo.request<WcOrder>('GET', `/orders/${a.order_id}`);
    const after = await woo.request<WcOrder>('PUT', `/orders/${a.order_id}`, { body: { status: a.status } });
    return { id: after.id, number: after.number, previous_status: before.status, status: after.status };
  }));
}
