// SEC-04: member vs admin routes, API keys on /mcp (revoked, malformed, prefix guessing, timing), IDOR.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, api, auditRows, demoUsers, mcp, median, tempKey, ZERO_ID } from './lib.mjs';

let a, b, upstreamId;
beforeAll(async () => {
  ({ a, b } = await demoUsers());
  upstreamId = (await api('GET', '/api/upstreams', { cookie: a.cookie })).body[0].id;
});

describe('TC-SEC-04-1 member calls every admin route', () => {
  const cases = () => [
    ['GET', '/api/users'], ['PATCH', `/api/users/${a.user.id}`, { disabled: true }], ['PATCH', `/api/users/${b.user.id}`, { role: 'admin' }],
    ['POST', '/api/invites', { email: 'sec-x@example.invalid', role: 'admin' }], ['GET', '/api/invites'], ['DELETE', `/api/invites/${ZERO_ID}`],
    ['POST', `/api/users/${a.user.id}/keys`, { name: 'x' }], ['POST', `/api/users/${b.user.id}/keys`, { name: 'x' }], ['GET', '/api/keys?all=1'],
    ['GET', '/api/audit'], ['GET', `/api/audit?user=${a.user.id}`],
    ['POST', '/api/upstreams', { name: 'x', slug: 'secx', url: 'https://example.com/mcp', authType: 'none' }],
    ['PATCH', `/api/upstreams/${upstreamId}`, { enabled: false }], ['PATCH', `/api/upstreams/${upstreamId}`, { memberAccess: 'all' }],
    ['DELETE', `/api/upstreams/${upstreamId}`],
  ];
  it('every admin route → 403 for B, 401 anonymous', async () => {
    const got = [];
    for (const [m, p, body] of cases()) {
      const mem = await api(m, p, { cookie: b.cookie, body });
      const anon = await api(m, p, { body });
      got.push(`${m} ${p.replace(/[0-9a-f-]{36}/g, ':id')} member ${mem.status} anon ${anon.status}`);
      expect.soft([mem.status, anon.status], `${m} ${p}`).toEqual([403, 401]);
    }
    console.log(got.join('\n'));
  });
  it('B is still a member and the upstream is unchanged afterwards', async () => {
    expect((await api('GET', '/api/me', { cookie: b.cookie })).body.role).toBe('member');
    const ups = (await api('GET', '/api/upstreams', { cookie: a.cookie })).body;
    expect(ups.find((u) => u.id === upstreamId).enabled).toBe(true);
  });
  it('the admin view of upstreams leaks no credential to anyone', async () => {
    for (const cookie of [a.cookie, b.cookie]) {
      const r = await api('GET', '/api/upstreams', { cookie });
      expect(r.text).not.toMatch(/"credential"|ck_[0-9a-f]{20}|cs_[0-9a-f]{20}|gh[pous]_[A-Za-z0-9]{20}|github_pat_/);
    }
  });
});

describe('TC-SEC-04-2 revoked and malformed keys on /mcp', () => {
  it('a revoked key stops working on the next request', async () => {
    const k = await tempKey(b.cookie);
    expect((await mcp(k.key, 'tools/list')).status).toBe(200);
    expect((await k.revoke()).status).toBe(204);
    const r = await mcp(k.key, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });
  it.each([
    ['no header', null], ['empty bearer', ''], ['wrong prefix', 'sk_live_abc'], ['too short', 'mgw_abc'],
    ['too long', `mgw_${'A'.repeat(4000)}`], ['non-base62', `mgw_${'!'.repeat(43)}`], ['SQL-ish', "mgw_' OR '1'='1"],
    ['session id as key', 'SESSION'], ['internal-token format', `itk_${Buffer.from('{"u":"x"}').toString('base64url')}.forged`],
  ])('%s → 401', async (_name, token) => {
    const t = token === 'SESSION' ? b.cookie.split('=')[1] : token;
    const r = await mcp(t, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.text).not.toMatch(/stack|at \w+ \(|node_modules/);
  });
  it('Basic auth and a key in the query string are refused', async () => {
    const k = await tempKey(b.cookie);
    try {
      const basic = await fetch(`${APP}/mcp`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`x:${k.key}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      expect(basic.status).toBe(401);
      const q = await fetch(`${APP}/mcp?api_key=${k.key}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      expect(q.status).toBe(401);
    } finally { await k.revoke(); }
  });
});

describe('TC-SEC-04-3 key prefix enumeration and timing', () => {
  it('a real prefix with a wrong body is refused exactly like a random key', async () => {
    const k = await tempKey(b.cookie);
    try {
      const forged = k.key.slice(0, 12) + 'x'.repeat(k.key.length - 12);
      const one = await mcp(forged, 'tools/list'), two = await mcp(`mgw_${'y'.repeat(43)}`, 'tools/list');
      expect([one.status, two.status]).toEqual([401, 401]);
      expect(one.text).toBe(two.text);
    } finally { await k.revoke(); }
  });
  it('no timing signal between a known prefix and a random key (median difference < 15 ms)', async () => {
    const k = await tempKey(b.cookie);
    try {
      const forged = k.key.slice(0, 12) + 'z'.repeat(k.key.length - 12), random = `mgw_${'q'.repeat(43)}`;
      const t = { forged: [], random: [] };
      for (let i = 0; i < 30; i++) for (const [name, key] of [['forged', forged], ['random', random]]) {
        const s = performance.now(); await mcp(key, 'tools/list'); t[name].push(performance.now() - s);
      }
      const diff = Math.abs(median(t.forged) - median(t.random));
      console.log(`median forged ${median(t.forged).toFixed(1)} ms, random ${median(t.random).toFixed(1)} ms, diff ${diff.toFixed(1)} ms`);
      expect(diff).toBeLessThan(15);
    } finally { await k.revoke(); }
  });
});

describe('TC-SEC-04-4 IDOR on keys, users and audit rows', () => {
  let aKey;
  beforeAll(async () => { aKey = await tempKey(a.cookie, 'sec-test admin key'); });
  afterAll(async () => { await aKey.revoke(); });
  it('B cannot revoke, see or rename A\'s key', async () => {
    expect((await api('DELETE', `/api/keys/${aKey.id}`, { cookie: b.cookie })).status).toBe(404);
    const own = (await api('GET', '/api/keys', { cookie: b.cookie })).body;
    expect(own.every((k) => k.owner.id === b.user.id)).toBe(true);
    expect(own.some((k) => k.id === aKey.id)).toBe(false);
    expect((await mcp(aKey.key, 'tools/list')).status).toBe(200); // still active
  });
  it('B cannot mint a key for A or read A\'s user record', async () => {
    expect((await api('POST', `/api/users/${a.user.id}/keys`, { cookie: b.cookie, body: { name: 'pwn' } })).status).toBe(403);
    expect((await api('GET', `/api/users/${a.user.id}`, { cookie: b.cookie })).status).toBeOneOf([403, 404]);
  });
  it('B cannot read audit rows, not even filtered to B', async () => {
    expect((await api('GET', `/api/audit?user=${b.user.id}`, { cookie: b.cookie })).status).toBe(403);
  });
  it('mass assignment: extra fields on own key / login are refused', async () => {
    const r = await api('POST', '/api/keys', { cookie: b.cookie, body: { name: 'x', userId: a.user.id } });
    expect(r.status).toBe(400);
    const l = await api('POST', '/api/auth/login', { body: { email: b.email, password: 'x', role: 'admin' } });
    expect(l.status).toBe(400);
  });
  it('a forbidden tool call is refused and audited under B (rejected/tool_forbidden)', async () => {
    const k = await tempKey(b.cookie);
    try {
      const r = await mcp(k.key, 'tools/call', { name: 'woo__create_product', arguments: { name: 'sec-test', regular_price: '1' } });
      expect(r.status).toBe(200);
      expect(r.body.error?.message ?? '').toMatch(/tool_forbidden|not allowed/i);
      const rows = await auditRows(a.cookie, { user: b.user.id, outcome: 'rejected' });
      expect(rows.some((x) => x.tool === 'woo__create_product' && x.errorCode === 'tool_forbidden' && x.keyPrefix === k.prefix)).toBe(true);
    } finally { await k.revoke(); }
  });
  it('a tool name that is not a real server__tool is refused', async () => {
    const k = await tempKey(b.cookie);
    try {
      for (const name of ['woo__../admin', 'nosuch__list_orders', '__list_orders', 'woo__', 'woo____list_orders']) {
        const r = await mcp(k.key, 'tools/call', { name, arguments: {} });
        expect.soft(r.body?.error, name).toBeTruthy();
      }
    } finally { await k.revoke(); }
  });
});
