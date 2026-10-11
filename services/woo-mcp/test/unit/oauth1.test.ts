import { describe, expect, it } from 'vitest';
import { rfc3986, signParams } from '../../src/oauth1.js';

const vector = {
  method: 'GET',
  signingUrl: 'http://store.example.test/',
  route: '/wp-json/wc/v3/products',
  query: { search: 'a b+c ~*é', per_page: 5, status: 'any' },
  key: 'ck_test',
  secret: 'cs_secret',
  nowMs: 1760140800_000,
  nonce: 'abc123',
};

describe('OAuth1 signer (WooCommerce flavour)', () => {
  it('TC-UNIT-06a matches an independent reference of the PHP algorithm', () => {
    // Expected value computed with a separate Python port of WC_REST_Authentication::check_oauth_signature.
    expect(signParams(vector).oauth_signature).toBe('rNMGIWaXZvRrGToxAybnG29A41WrsgPLmmEHUrRIZ58=');
  });

  it('TC-UNIT-06b changes when the secret, the signing URL or a parameter changes', () => {
    const base = signParams(vector).oauth_signature;
    expect(signParams({ ...vector, secret: 'cs_other' }).oauth_signature).not.toBe(base);
    expect(signParams({ ...vector, signingUrl: 'http://wordpress.store.svc' }).oauth_signature).not.toBe(base);
    expect(signParams({ ...vector, query: { ...vector.query, per_page: 6 } }).oauth_signature).not.toBe(base);
  });

  it('drops undefined query values and adds the oauth parameters', () => {
    const p = signParams({ ...vector, query: { search: undefined, page: 2 } });
    expect(Object.keys(p).sort()).toEqual(['oauth_consumer_key', 'oauth_nonce', 'oauth_signature', 'oauth_signature_method', 'oauth_timestamp', 'page']);
    expect(p.oauth_timestamp).toBe('1760140800');
  });

  it('uses a fresh nonce per request (WooCommerce rejects reused nonces)', () => {
    const { nonce: _n, ...noNonce } = vector;
    expect(signParams(noNonce).oauth_nonce).not.toBe(signParams(noNonce).oauth_nonce);
  });

  it('encodes like PHP rawurlencode', () => {
    expect(rfc3986("a b+c~*!'()é")).toBe('a%20b%2Bc~%2A%21%27%28%29%C3%A9');
  });
});
