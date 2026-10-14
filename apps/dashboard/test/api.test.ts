// TC-UI-02-1: error mapping of the API client (status + body → code and user-facing message).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthenticatedHandler, toApiError } from '../src/api.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthenticatedHandler(() => {});
});

describe('TC-UI-02-1 toApiError', () => {
  it('known codes get a friendly message, not the raw server text', () => {
    const e = toApiError(401, { error: 'invalid_credentials', message: 'invalid credentials' }, null);
    expect([e.status, e.code, e.message]).toEqual([401, 'invalid_credentials', 'Wrong email or password.']);
    expect(toApiError(410, { error: 'invite_used' }, null).message).toMatch(/already been used/);
  });
  it('4xx with an unknown code keeps the server message (e.g. validation details)', () => {
    const e = toApiError(400, { error: 'validation_failed', message: 'body/password must NOT have fewer than 12 characters' }, null);
    expect(e.code).toBe('validation_failed');
    expect(e.message).toContain('12 characters');
  });
  it('5xx never shows server text; a non-JSON body (proxy page) still maps to a code', () => {
    expect(toApiError(500, { error: 'internal', message: 'pg: relation users …' }, null).message).not.toContain('pg');
    const e = toApiError(502, undefined, null);
    expect([e.code, e.message]).toEqual(['internal', 'Something went wrong on the server. Please try again.']);
    expect(toApiError(418, undefined, null).code).toBe('http_418');
  });
  it('rate_limited uses Retry-After (seconds → minutes)', () => {
    const e = toApiError(429, { error: 'rate_limited' }, '840');
    expect(e.retryAfterSec).toBe(840);
    expect(e.message).toBe('Too many attempts. Try again in 14 minutes.');
    expect(toApiError(429, { error: 'rate_limited' }, null).message).toBe('Too many attempts. Try again later.');
  });
});

describe('api()', () => {
  it('sends JSON same-origin and returns the parsed body; 204 → undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { ok: 1 })).mockResolvedValueOnce(json(204, null));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api('/api/x', { method: 'POST', body: { a: 1 } })).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"a":1}' });
    expect(init.headers['content-type']).toBe('application/json');
    expect(await api('/api/auth/logout', { method: 'POST' })).toBeUndefined();
  });
  it('401 unauthenticated → the handler runs (redirect to login); invalid_credentials does not', async () => {
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(401, { error: 'unauthenticated' }))
      .mockResolvedValueOnce(json(401, { error: 'invalid_credentials' })));
    await expect(api('/api/me')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(api('/api/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('a network failure becomes network_error; an abort stays an abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    const e = await api('/api/me').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('network_error');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abort));
    await expect(api('/api/me')).rejects.toBe(abort);
  });
});
