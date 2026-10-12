import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential, loadCredentialKey } from '../../src/crypto/credentials.js';
import { toPublic } from '../../src/upstreams/repo.js';

const key = loadCredentialKey({ CREDENTIALS_KEY: randomBytes(32).toString('hex') });

describe('credential encryption (D-009)', () => {
  it('TC-GW-03-U1: round trip; ciphertext differs every time and never contains the plaintext', () => {
    const a = encryptCredential(key, 'woo', 'secret-token-123');
    const b = encryptCredential(key, 'woo', 'secret-token-123');
    expect(decryptCredential(key, 'woo', a)).toBe('secret-token-123');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain('secret-token-123');
  });

  it('TC-GW-03-U2: wrong key, other upstream (slug) or tampered bytes → throws', () => {
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
      authHeader: null, credentialEnc: encryptCredential(key, 'woo', 't'), createdBy: null, createdAt: now, updatedAt: now,
    });
    expect(pub.hasCredential).toBe(true);
    expect(Object.keys(pub)).not.toContain('credentialEnc');
    expect(JSON.stringify(pub)).not.toMatch(/ciphertext|"iv"|"tag"/);
  });
});
