import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decryptCredential, encryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import type { Upstream } from '../../src/db/schema.js';
import { UpstreamPool, upstreamHeaders, UpstreamUnavailableError } from '../../src/upstreams/pool.js';
import { toPublic } from '../../src/upstreams/repo.js';

const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });

describe('credential encryption (D-009)', () => {
  it('TC-UNIT-05 / TC-GW-03-U1: round trip; ciphertext differs every time and never contains the plaintext', () => {
    const a = encryptCredential(key, 'woo', 'secret-token-123');
    const b = encryptCredential(key, 'woo', 'secret-token-123');
    expect(decryptCredential(key, 'woo', a)).toBe('secret-token-123');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain('secret-token-123');
  });

  it('TC-UNIT-05 / TC-GW-03-U2: wrong key, other upstream (slug) or tampered bytes → throws', () => {
    const enc = encryptCredential(key, 'woo', 'secret-token-123');
    const other = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
    expect(() => decryptCredential(other, 'woo', enc)).toThrow();
    expect(() => decryptCredential(key, 'github', enc)).toThrow();
    const bytes = Buffer.from(enc.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    expect(() => decryptCredential(key, 'woo', { ...enc, ciphertext: bytes.toString('base64') })).toThrow();
  });

  it('TC-GW-03-U3: key must be 32 bytes of hex', () => {
    expect(() => loadCredentialKey({})).toThrow(/CREDENTIALS_KEY/);
    expect(() => loadCredentialKey({ CREDENTIALS_KEY: 'ab'.repeat(16) })).toThrow(/CREDENTIALS_KEY/);
    expect(() => loadCredentialKey({ CREDENTIALS_KEY: 'zz'.repeat(32) })).toThrow(/CREDENTIALS_KEY/);
  });

  it('TC-GW-03-U4: public shape exposes hasCredential, never the credential', () => {
    const now = new Date();
    const pub = toPublic({
      id: 'id', slug: 'woo', name: 'WooCommerce', url: 'http://x/mcp', enabled: true, authType: 'bearer',
      authHeader: null, credentialEnc: encryptCredential(key, 'woo', 't'), memberAccess: 'all', memberTools: [], createdBy: null, createdAt: now, updatedAt: now,
    });
    expect(pub.hasCredential).toBe(true);
    expect(Object.keys(pub)).not.toContain('credentialEnc');
    expect(JSON.stringify(pub)).not.toMatch(/ciphertext|"iv"|"tag"/);
  });
});

function row(over: Partial<Upstream>): Upstream {
  const now = new Date('2026-10-13T00:00:00Z');
  return { id: 'u1', slug: 'woo', name: 'Woo', url: 'http://up/mcp', enabled: true, authType: 'none', authHeader: null,
    credentialEnc: null, memberAccess: 'all', memberTools: [], createdBy: null, createdAt: now, updatedAt: now, ...over };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe('credential injection (GW-12)', () => {
  it('TC-GW-12-U1: headers carry only the upstream\'s own decrypted credential', () => {
    const ua = expect.stringMatching(/^mcp-gateway\//);
    expect(upstreamHeaders(key, row({}))).toEqual({ 'user-agent': ua });
    expect(upstreamHeaders(key, row({ authType: 'bearer', credentialEnc: encryptCredential(key, 'woo', 'tok-b') })))
      .toEqual({ 'user-agent': ua, authorization: 'Bearer tok-b' });
    expect(upstreamHeaders(key, row({ authType: 'header', authHeader: 'X-Api-Key', credentialEnc: encryptCredential(key, 'woo', 'tok-h') })))
      .toEqual({ 'user-agent': ua, 'x-api-key': 'tok-h' });
  });

  it('TC-GW-12-U2: undecryptable or header-breaking credential → UpstreamUnavailableError without the value', () => {
    const other = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });
    const cases = [
      row({ authType: 'bearer', credentialEnc: encryptCredential(other, 'woo', 'secret-a') }), // key rotated
      row({ authType: 'bearer', credentialEnc: encryptCredential(key, 'github', 'secret-b') }), // copied from another row
      row({ authType: 'bearer', credentialEnc: encryptCredential(key, 'woo', 'secret-c\r\nX-Evil: 1') }), // header injection
      row({ authType: 'header', authHeader: 'X-Api-Key', credentialEnc: encryptCredential(key, 'woo', 'secret-d\u0000') }),
    ];
    for (const r of cases) {
      let err: unknown;
      try { upstreamHeaders(key, r); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(UpstreamUnavailableError);
      expect((err as Error).message).toMatch(/^upstream woo unreachable: stored credential /);
      expect((err as Error).message).not.toMatch(/secret|Evil/);
    }
  });

  it('TC-GW-12-U3: a redirecting upstream is not followed; the credential never reaches the redirect target', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const listen = async (handler: Parameters<typeof createServer>[1]) => {
      const srv = createServer(handler);
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      cleanup.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    };
    const target = await listen((req, res) => { seen.push(req.headers); res.writeHead(500).end(); });
    const redirector = await listen((_req, res) => { res.writeHead(307, { location: target }).end(); });
    const p = new UpstreamPool({ key, connectTimeoutMs: 1_000 });
    cleanup.unshift(() => p.close());
    await p.sync([row({ url: redirector, authType: 'header', authHeader: 'X-Api-Key', credentialEnc: encryptCredential(key, 'woo', 'tok-redirect') })]);
    await expect(p.withClient('u1', (c) => c.listTools())).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(seen).toEqual([]); // nothing, so no X-Api-Key, reached the other server
    // Note: this passes on two layers (the SDK's same-origin policy and our `redirect: 'error'`).
  });
});
