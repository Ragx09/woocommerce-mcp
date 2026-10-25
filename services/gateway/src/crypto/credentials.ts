// Upstream credentials at rest (D-009): AES-256-GCM with a 32-byte key from the K8s Secret
// gateway-secrets/credentials-key. The upstream slug is bound as associated data, so a ciphertext
// copied onto another upstream row does not decrypt. Plaintext only ever exists in memory.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedCredential } from '../db/schema.js';

export type CredentialKey = Buffer & { readonly __brand: 'CredentialKey' };

/** CREDENTIALS_KEY: 64 hex characters (32 bytes). */
export function loadCredentialKey(env: NodeJS.ProcessEnv = process.env): CredentialKey {
  const hex = env.CREDENTIALS_KEY?.trim() ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('CREDENTIALS_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(hex, 'hex') as CredentialKey;
}

const aad = (slug: string) => Buffer.from(`upstream:${slug}`, 'utf8');

export function encryptCredential(key: CredentialKey, slug: string, plaintext: string): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(slug));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Throws if the key, slug or any byte of the ciphertext is wrong (GCM authentication). */
export function decryptCredential(key: CredentialKey, slug: string, enc: EncryptedCredential): string {
  if (enc.v !== 1) throw new Error(`unsupported credential version ${String(enc.v)}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(aad(slug));
  const tag = Buffer.from(enc.tag, 'base64');
  if (tag.length !== 16) throw new Error('invalid authentication tag length');
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
