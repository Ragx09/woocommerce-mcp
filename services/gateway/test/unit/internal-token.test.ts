// UI-15 unit tests: the internal chat token (src/auth/internal-token.ts).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INTERNAL_TOKEN_TTL_MS, InternalTokenSigner, isLoopback } from '../../src/auth/internal-token.js';
import { scrubString } from '../../src/logger.js';

const USER = '0b0e6f5e-3c1a-4c6e-9b1e-2f7f1f0e8a11';
const NOW = 1_800_000_000_000;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('TC-UI-15-U1 internal token', () => {
  const signer = new InternalTokenSigner();

  it('round-trips the user id until it expires (5 min)', () => {
    const t = signer.mint(USER, NOW);
    expect(t).toMatch(/^itk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(signer.verify(t, NOW)).toBe(USER);
    expect(signer.verify(t, NOW + INTERNAL_TOKEN_TTL_MS - 1)).toBe(USER);
    expect(signer.verify(t, NOW + INTERNAL_TOKEN_TTL_MS)).toBeNull();
  });

  it('refuses tokens from another key (another process or replica)', () => {
    expect(new InternalTokenSigner().verify(signer.mint(USER, NOW), NOW)).toBeNull();
  });

  it('refuses a payload changed under the original signature', () => {
    const [head, sig] = signer.mint(USER, NOW).split('.') as [string, string];
    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const forged = `itk_${b64({ sub: other, src: 'chat', exp: NOW + 60_000 })}.${sig}`;
    expect(head).not.toBe(forged.split('.')[0]);
    expect(signer.verify(forged, NOW)).toBeNull();
    const longer = `itk_${b64({ sub: USER, src: 'chat', exp: NOW + 10 * INTERNAL_TOKEN_TTL_MS })}.${sig}`;
    expect(signer.verify(longer, NOW + INTERNAL_TOKEN_TTL_MS)).toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    const t = signer.mint(USER, NOW);
    for (const bad of ['', 'itk_', 'itk_.', t.slice(4), `${t}x`, `${t}.x`, t.replace('itk_', 'ITK_'), `Bearer ${t}`, 'mgw_abc', `itk_${'a'.repeat(600)}.${'b'.repeat(43)}`]) {
      expect(signer.verify(bad, NOW)).toBeNull();
    }
  });

  it('mint refuses non-UUID users and TTLs over 5 min', () => {
    expect(() => signer.mint('alice', NOW)).toThrow(/UUID/);
    expect(() => signer.mint(USER, NOW, INTERNAL_TOKEN_TTL_MS + 1)).toThrow(/ttlMs/);
    expect(() => signer.mint(USER, NOW, 0)).toThrow(/ttlMs/);
    expect(() => new InternalTokenSigner(Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('a validly signed payload must still say src=chat and carry a UUID and a numeric exp', () => {
    // Sign arbitrary payloads with a known key to reach the checks behind the signature.
    const key = Buffer.alloc(32, 7);
    const s = new InternalTokenSigner(key);
    const sign = (o: unknown) => { const p = b64(o); return `itk_${p}.${createHmac('sha256', key).update(p).digest('base64url')}`; };
    expect(s.verify(sign({ sub: USER, src: 'chat', exp: NOW + 1000 }), NOW)).toBe(USER);
    expect(s.verify(sign({ sub: USER, src: 'mcp', exp: NOW + 1000 }), NOW)).toBeNull();
    expect(s.verify(sign({ sub: 'admin', src: 'chat', exp: NOW + 1000 }), NOW)).toBeNull();
    expect(s.verify(sign({ sub: USER, src: 'chat', exp: String(NOW + 1000) }), NOW)).toBeNull();
    expect(s.verify(sign({ sub: USER, src: 'chat' }), NOW)).toBeNull();
  });

  it('is scrubbed from log text', () => {
    const t = signer.mint(USER, NOW);
    expect(scrubString(`calling with ${t} now`)).not.toContain(t.slice(8));
  });
});

describe('TC-UI-15-U2 loopback check uses the socket address only', () => {
  it('accepts IPv4/IPv6 loopback, refuses everything else', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of [undefined, '', '10.42.0.7', '::ffff:10.42.0.7', '127.0.0.2', '0.0.0.0', 'localhost']) expect(isLoopback(a)).toBe(false);
  });
});
