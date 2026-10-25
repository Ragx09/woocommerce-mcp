// TC-BON-14-4 (unit): the pure decision behind store access — who gets which role for a store's server — and the
// config that caps and addresses stores (BON-12).
import { describe, expect, it } from 'vitest';
import { roleFor, type StoreAccess } from '../../src/authz/store-access.js';
import { loadConfig } from '../../src/config.js';
import { slugFromName } from '../../src/stores/routes.js';

const store = { storeId: 's1' };
const plain = { storeId: null, hostedId: null };

describe('roleFor', () => {
  const access: StoreAccess = new Map([['s1', 'owner'], ['s2', 'shared']]);
  it('servers without a store follow the role alone', () => {
    expect(roleFor(plain, 'member', access)).toBe('member');
    expect(roleFor(plain, 'admin', undefined)).toBe('admin');
  });
  it('admin → all tools of every store; owner → all tools; shared → the member rule; nobody → hidden', () => {
    expect(roleFor(store, 'admin', new Map())).toBe('admin');
    expect(roleFor(store, 'member', access)).toBe('admin'); // owner: everything
    expect(roleFor({ storeId: 's2' }, 'member', access)).toBe('member'); // shared: the store's rule
    expect(roleFor({ storeId: 's3' }, 'member', access)).toBeNull();
  });
  it('fails closed without an access source', () => {
    expect(roleFor(store, 'member', undefined)).toBeNull();
    expect(roleFor(store, 'member', new Map())).toBeNull();
  });
});

describe('stores config', () => {
  it('defaults: 3 per member, 5 in total, http, no host suffix', () => {
    expect(loadConfig({}).stores).toEqual({ maxPerMember: 3, maxTotal: 5, hostSuffix: undefined, scheme: 'http', defaultStoreUrl: undefined });
  });
  it('reads the chart values and refuses a bad host suffix', () => {
    const c = loadConfig({ STORE_MAX_PER_MEMBER: '1', STORE_MAX_TOTAL: '2', STORE_HOST_SUFFIX: 'Store.Example.com', STORE_SCHEME: 'https', DEFAULT_STORE_URL: 'https://store.example.com' });
    expect(c.stores).toEqual({ maxPerMember: 1, maxTotal: 2, hostSuffix: 'store.example.com', scheme: 'https', defaultStoreUrl: 'https://store.example.com' });
    expect(() => loadConfig({ STORE_HOST_SUFFIX: 'bad host/x' })).toThrow(/STORE_HOST_SUFFIX/);
    expect(() => loadConfig({ STORE_MAX_TOTAL: '-1' })).toThrow(/STORE_MAX_TOTAL/);
  });
});

describe('slugFromName', () => {
  it('keeps slugs valid for the database CHECK (3–16 chars, letter first, no double hyphen)', () => {
    const re = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;
    for (const n of ['Chai Corner', 'Ünï--cøde!!', '123 Numbers', 'A  B  C  D  E  F  G  H  I', '---x---y---', 'This Is A Really Long Store Name']) {
      const s = slugFromName(n);
      expect(s === '' || re.test(s) && !s.includes('--'), `${n} → ${s}`).toBe(true);
    }
    expect(slugFromName('!!')).toBe('');
  });
});
