// SEC-04: CSRF, session handling (fixation, logout, cookie reuse, disabled user) and invite tokens.
// Uses a throwaway member created through the invite flow (left disabled at the end), never user B.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, demoUsers, mcp, rand, tempKey } from './lib.mjs';

let a, t; // t = throwaway member { id, email, password, cookie }
beforeAll(async () => {
  ({ a } = await demoUsers());
  const email = `sec-${rand()}@example.invalid`, password = `pw-${rand(12)}`;
  const inv = await api('POST', '/api/invites', { cookie: a.cookie, body: { email, role: 'member' } });
  expect(inv.status).toBe(201);
  const token = new URL(inv.body.inviteUrl).hash.slice(1);
  const acc = await api('POST', '/api/invites/accept', { body: { token, name: 'sec test', password } });
  expect(acc.status).toBe(201);
  t = { id: acc.body.user.id, email, password, token, cookie: acc.cookie };
});
afterAll(async () => {
  if (t) await api('PATCH', `/api/users/${t.id}`, { cookie: a.cookie, body: { disabled: true } });
});

const login = (email, password, extra = {}) => api('POST', '/api/auth/login', { body: { email, password }, ...extra });

describe('TC-SEC-04-5 invite tokens', () => {
  it('a used invite token cannot be checked or accepted again', async () => {
    expect((await api('POST', '/api/invites/check', { body: { token: t.token } })).status).toBe(410);
    const again = await api('POST', '/api/invites/accept', { body: { token: t.token, name: 'again', password: `pw-${rand(12)}` } });
    expect(again.status).toBe(410);
    expect(again.cookie).toBeUndefined();
  });
  it('a withdrawn invite is dead; a guessed token is 404', async () => {
    const inv = await api('POST', '/api/invites', { cookie: a.cookie, body: { email: `sec-${rand()}@example.invalid` } });
    const token = new URL(inv.body.inviteUrl).hash.slice(1);
    expect((await api('DELETE', `/api/invites/${inv.body.id}`, { cookie: a.cookie })).status).toBe(204);
    expect((await api('POST', '/api/invites/accept', { body: { token, name: 'x', password: `pw-${rand(12)}` } })).status).toBe(404);
    expect((await api('POST', '/api/invites/check', { body: { token: token.slice(0, -2) + 'AA' } })).status).toBe(404);
  });
  it('an invite cannot be accepted with a role or email of the caller\'s choosing', async () => {
    const inv = await api('POST', '/api/invites', { cookie: a.cookie, body: { email: `sec-${rand()}@example.invalid` } });
    const token = new URL(inv.body.inviteUrl).hash.slice(1);
    const r = await api('POST', '/api/invites/accept', { body: { token, name: 'x', password: `pw-${rand(12)}`, role: 'admin' } });
    expect(r.status).toBe(400);
    await api('DELETE', `/api/invites/${inv.body.id}`, { cookie: a.cookie });
  });
});

describe('TC-SEC-04-6 CSRF', () => {
  it.each([
    ['foreign Origin', { origin: 'http://evil.example' }],
    ['null Origin', { origin: 'null' }],
    ['no Origin, no Sec-Fetch-Site', { origin: false }],
    ['cross-site Sec-Fetch-Site', { origin: false, headers: { 'sec-fetch-site': 'cross-site' } }],
    ['look-alike Origin', { origin: 'http://app.127.0.0.1.nip.io.evil.example' }],
  ])('%s on a cookie mutation → 403', async (_n, opts) => {
    const r = await api('POST', '/api/keys', { cookie: t.cookie, body: { name: 'csrf' }, ...opts });
    expect(r.status).toBe(403);
  });
  it('a form-encoded (simple) request cannot create a key', async () => {
    const r = await api('POST', '/api/keys', { cookie: t.cookie, origin: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBeOneOf([400, 403, 415]);
  });
  it('the session cookie is HttpOnly + SameSite=Strict', async () => {
    const res = await fetch(`${process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io'}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: process.env.APP_ORIGIN ?? 'http://app.127.0.0.1.nip.io' },
      body: JSON.stringify({ email: t.email, password: t.password }),
    });
    const c = res.headers.get('set-cookie');
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Strict/i);
  });
});

describe('TC-SEC-04-7 session handling', () => {
  it('fixation: a cookie chosen before login is replaced and never authenticates', async () => {
    const planted = 'sid=planted-by-attacker-0000000000000000000000';
    const r = await login(t.email, t.password, { cookie: planted });
    expect(r.status).toBe(200);
    expect(r.cookie).toMatch(/^sid=/);
    expect(r.cookie).not.toBe(planted);
    expect((await api('GET', '/api/me', { cookie: planted })).status).toBe(401);
  });
  it('two logins get two different sessions', async () => {
    const one = await login(t.email, t.password), two = await login(t.email, t.password);
    expect(one.cookie).not.toBe(two.cookie);
  });
  it('after logout the old cookie is dead (server-side session deleted)', async () => {
    const s = (await login(t.email, t.password)).cookie;
    expect((await api('GET', '/api/me', { cookie: s })).status).toBe(200);
    expect((await api('POST', '/api/auth/logout', { cookie: s })).status).toBe(204);
    expect((await api('GET', '/api/me', { cookie: s })).status).toBe(401);
    expect((await api('POST', '/api/keys', { cookie: s, body: { name: 'reuse' } })).status).toBe(401);
  });
  it('a disabled user loses sessions and keys at once; wrong and right passwords look the same', async () => {
    const s = (await login(t.email, t.password)).cookie;
    const k = await tempKey(s);
    expect((await mcp(k.key, 'tools/list')).status).toBe(200);
    expect((await api('PATCH', `/api/users/${t.id}`, { cookie: a.cookie, body: { disabled: true } })).status).toBe(200);
    expect((await api('GET', '/api/me', { cookie: s })).status).toBe(401);
    expect((await mcp(k.key, 'tools/list')).status).toBe(401);
    const right = await login(t.email, t.password), wrong = await login(t.email, 'wrong-password-123');
    expect([right.status, wrong.status]).toEqual([401, 401]);
    expect(right.text).toBe(wrong.text);
  });
});
