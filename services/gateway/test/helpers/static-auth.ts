// Test stand-in for the DB-backed API-key check (src/auth/api-keys.ts): accepts exactly one key.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../../src/auth/api-keys.js';

const digest = (s: string) => createHash('sha256').update(s).digest();
export const TEST_PRINCIPAL: Principal = { userId: '00000000-0000-4000-8000-000000000001', keyId: '00000000-0000-4000-8000-000000000002', role: 'member', email: 'test@example.test' };

export function staticKeyAuth(key: string | undefined): (bearer: string) => Promise<Principal | null> {
  return async (bearer) => (key && timingSafeEqual(digest(bearer), digest(key)) ? TEST_PRINCIPAL : null);
}
