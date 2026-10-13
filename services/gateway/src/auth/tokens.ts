// Random tokens for sessions, invites and API keys. Only their SHA-256 is stored (D-007, D-008): the
// values are 256-bit random, so a fast hash is enough and lookups by hash leak nothing through timing.
import { createHash, randomBytes } from 'node:crypto';

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 32 random bytes, base64url (43 characters). */
export const randomToken = (): string => randomBytes(32).toString('base64url');
