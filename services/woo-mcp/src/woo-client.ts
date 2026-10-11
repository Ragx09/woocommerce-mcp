// Minimal WooCommerce REST v3 client. Signed URLs contain the consumer key, so URLs are never
// logged or put into error messages.
import { signParams, type QueryValue } from './oauth1.js';
import type { Config } from './config.js';

export type WooErrorKind = 'not_found' | 'invalid_request' | 'auth' | 'unreachable' | 'timeout' | 'upstream';

/** An error whose message is safe to show to MCP clients and the LLM. */
export class WooError extends Error {
  constructor(readonly kind: WooErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'WooError';
  }
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);

export interface StoreInfo { timezone: string; gmtOffsetHours: number }

export class WooClient {
  private storeInfo?: { value: StoreInfo; at: number };

  constructor(private readonly cfg: Config, private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: { query?: Record<string, QueryValue | undefined>; body?: unknown } = {}): Promise<T> {
    const route = `/wp-json/wc/v3${path}`;
    const params = signParams({ method, signingUrl: this.cfg.wooSigningUrl, route, query: opts.query, key: this.cfg.wooConsumerKey, secret: this.cfg.wooConsumerSecret });
    const url = new URL(this.cfg.wooBaseUrl + route);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.send(url, method, opts.body);
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.ok) return json as T;

    const wcMessage = typeof (json as { message?: unknown })?.message === 'string' ? stripHtml((json as { message: string }).message) : '';
    if (res.status === 401 || res.status === 403) throw new WooError('auth', 'The store rejected the MCP server credentials.', res.status);
    if (res.status === 404) throw new WooError('not_found', wcMessage || 'Not found.', 404);
    if (res.status === 400) throw new WooError('invalid_request', wcMessage || 'The store rejected the request.', 400);
    throw new WooError('upstream', `The store returned HTTP ${res.status}${wcMessage ? `: ${wcMessage}` : ''}.`, res.status);
  }

  /** Store timezone from the public REST index (unauthenticated), cached for 10 minutes. */
  async getStoreInfo(): Promise<StoreInfo> {
    if (this.storeInfo && Date.now() - this.storeInfo.at < 600_000) return this.storeInfo.value;
    const res = await this.send(new URL(this.cfg.wooBaseUrl + '/wp-json/'), 'GET');
    if (!res.ok) throw new WooError('upstream', `The store returned HTTP ${res.status} for its index.`, res.status);
    const idx = (await res.json()) as { timezone_string?: string; gmt_offset?: number | string };
    const value = { timezone: idx.timezone_string || 'UTC', gmtOffsetHours: Number(idx.gmt_offset ?? 0) };
    this.storeInfo = { value, at: Date.now() };
    return value;
  }

  private async send(url: URL, method: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.wooTimeoutMs),
        redirect: 'error', // a redirect would mean a mis-set home URL; never follow it with signed params
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new WooError('timeout', `The store did not answer within ${this.cfg.wooTimeoutMs} ms.`);
      throw new WooError('unreachable', 'The store is unreachable.');
    }
  }
}
