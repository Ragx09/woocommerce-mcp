// WooClient transport details that only show up behind TLS (VPS), not on plain-http k3d.
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { WooClient } from '../../src/woo-client.js';

const base: Config = {
  port: 0, wooBaseUrl: 'http://wordpress.store.svc', wooSigningUrl: 'http://store.example.test',
  wooConsumerKey: 'ck_x', wooConsumerSecret: 'cs_x', wooTimeoutMs: 200, mcpAuthToken: 't', logLevel: 'silent',
};

async function headersSent(cfg: Config): Promise<Headers> {
  let sent = new Headers();
  const fakeFetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    sent = new Headers(init.headers);
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  await new WooClient(cfg, fakeFetch).request('GET', '/products');
  return sent;
}

describe('WooClient X-Forwarded-Proto', () => {
  it('says https when signing for an https store but calling it over in-cluster http', async () => {
    const h = await headersSent({ ...base, wooSigningUrl: 'https://store.example.test' });
    expect(h.get('x-forwarded-proto')).toBe('https');
  });

  it('sends nothing when the store is plain http (k3d)', async () => {
    expect((await headersSent(base)).get('x-forwarded-proto')).toBeNull();
  });
});
