// SEC-04: login brute force. Uses an email that does not exist, so no real account is locked out; the per-IP
// limit (20 failures / 15 min) is not driven to the end here because it would lock this machine's own logins.
import { describe, expect, it } from 'vitest';
import { api, rand } from './lib.mjs';

const PER_ACCOUNT = 5;

describe('TC-SEC-04-8 login brute force', () => {
  // One account, 5 failures that each try a bypass (spoofed X-Forwarded-For, other email case, spaces), so the
  // whole file costs 7 failures of this IP's 20 per 15 min (more would lock the next tests' logins).
  it(`the ${PER_ACCOUNT + 1}th wrong password → 429 + Retry-After, on any replica, whatever the bypass`, async () => {
    const base = `nobody-${rand()}@example.invalid`;
    const variants = [
      { email: base, headers: {} },
      { email: base, headers: { 'x-forwarded-for': '203.0.113.7' } },
      { email: base.toUpperCase(), headers: {} },
      { email: `  ${base} `, headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.8' } },
      { email: base, headers: { 'x-real-ip': '203.0.113.9' } },
    ];
    for (const v of variants) expect((await api('POST', '/api/auth/login', { body: { email: v.email, password: 'guess' }, headers: v.headers })).status).toBe(401);
    const r = await api('POST', '/api/auth/login', { body: { email: base, password: 'guess' }, headers: { 'x-forwarded-for': '192.0.2.1' } });
    console.log(`after ${PER_ACCOUNT} failures: ${r.status}, Retry-After ${r.headers.get('retry-after')} s`);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
  it('TC-SEC-04-8b SQL in the email: the same 401 as any unknown account (F-AUTH-3, ZAP false positive)', async () => {
    const one = await api('POST', '/api/auth/login', { body: { email: `z${rand()}@example.com' AND '1'='1' --`, password: 'x' } });
    const two = await api('POST', '/api/auth/login', { body: { email: `z${rand()}@example.com' AND '1'='2' --`, password: 'x' } });
    expect([one.status, two.status]).toEqual([401, 401]);
    expect(one.text).toBe(two.text);
  });
});
