import { describe, expect, it } from 'vitest';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { hashPassword, passwordProblem, verifyPassword } from '../../src/auth/password.js';
import { loadAdminSeed } from '../../src/auth/seed-admin.js';
import { loadConfig } from '../../src/config.js';

describe('passwords (AUTH-02)', () => {
  it('TC-AUTH-02-U1: argon2id PHC hash with the OWASP parameters; verify only the right password', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'correct horse batterY')).toBe(false);
    expect(await verifyPassword(h, 'x'.repeat(10_000))).toBe(false); // over the limit: rejected without hashing
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('TC-AUTH-02-U2: an unknown user costs as much as a wrong password (no timing enumeration)', async () => {
    const h = await hashPassword('correct horse battery');
    await verifyPassword(null, 'warm-up'); // the dummy hash is built once
    const time = async (f: () => Promise<boolean>) => { const t = performance.now(); for (let i = 0; i < 5; i++) await f(); return performance.now() - t; };
    const wrong = await time(() => verifyPassword(h, 'nope nope nope'));
    const unknown = await time(() => verifyPassword(null, 'nope nope nope'));
    expect(unknown).toBeGreaterThan(wrong * 0.5);
    expect(unknown).toBeLessThan(wrong * 2);
  });

  it('password rules and the admin seed from env', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
    expect(passwordProblem('long enough pass')).toBeNull();
    expect(loadAdminSeed({})).toBeNull();
    expect(loadAdminSeed({ ADMIN_EMAIL: ' Admin@Example.TEST ', ADMIN_PASSWORD: 'p'.repeat(24) }))
      .toEqual({ email: 'admin@example.test', name: 'Admin', password: 'p'.repeat(24) });
    expect(() => loadAdminSeed({ ADMIN_EMAIL: 'a@b.c', ADMIN_PASSWORD: 'weak' })).toThrow(/ADMIN_PASSWORD: password must be at least 12/);
    expect(loadConfig({}).cookieSecure).toBe(false);
    expect(loadConfig({ COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(() => loadConfig({ COOKIE_SECURE: 'yes' })).toThrow(/COOKIE_SECURE/);
  });
});

describe('LoginLimiter (AUTH-02)', () => {
  it('TC-AUTH-02-U3: 5 failures per IP+email, 20 per IP, sliding 15 min window; success clears the account counter', () => {
    const clock = { t: 0 };
    const l = new LoginLimiter({ now: () => clock.t });
    for (let i = 0; i < 5; i++) { expect(l.retryAfter('1.1.1.1', 'a@x')).toBe(0); l.fail('1.1.1.1', 'a@x'); }
    expect(l.retryAfter('1.1.1.1', 'a@x')).toBe(900);
    expect(l.retryAfter('2.2.2.2', 'a@x')).toBe(0); // another client is not locked out by the attacker
    expect(l.retryAfter('1.1.1.1', 'b@x')).toBe(0);
    clock.t += 900_001;
    expect(l.retryAfter('1.1.1.1', 'a@x')).toBe(0);

    for (let i = 0; i < 20; i++) l.fail('3.3.3.3', `user${i}@x`); // spraying many emails from one IP
    expect(l.retryAfter('3.3.3.3', 'fresh@x')).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) l.fail('4.4.4.4', 'c@x');
    l.succeed('4.4.4.4', 'c@x');
    l.fail('4.4.4.4', 'c@x');
    expect(l.retryAfter('4.4.4.4', 'c@x')).toBe(0);
  });
});

import type { FastifyRequest } from 'fastify';
import { originAllowed } from '../../src/auth/guard.js';

describe('Origin check (AUTH-03)', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as unknown as FastifyRequest;
  it('TC-AUTH-03-U1: mutations need our origin; reads and non-browser clients pass; no configured origin → fail closed', () => {
    const o = 'https://app.example.test';
    expect(originAllowed(req('POST', { origin: o }), o)).toBe(true);
    expect(originAllowed(req('DELETE', { origin: 'https://evil.example' }), o)).toBe(false);
    expect(originAllowed(req('PATCH', { 'sec-fetch-site': 'cross-site' }), o)).toBe(false);
    expect(originAllowed(req('GET', { origin: 'https://evil.example' }), o)).toBe(true);
    expect(originAllowed(req('POST', {}), o)).toBe(true);
    expect(originAllowed(req('POST', { origin: o }), undefined)).toBe(false);
    expect(loadConfig({ PUBLIC_ORIGIN: 'http://app.127.0.0.1.nip.io' }).publicOrigin).toBe('http://app.127.0.0.1.nip.io');
    for (const bad of ['app.example.test', 'https://app.example.test/', 'ftp://x.y', 'https://a.b/path']) {
      expect(() => loadConfig({ PUBLIC_ORIGIN: bad }), bad).toThrow(/PUBLIC_ORIGIN/);
    }
  });
});
