// Password hashing (D-007): argon2id with the OWASP baseline (19 MiB, 2 iterations, 1 lane).
// Hashes are PHC strings (`$argon2id$v=19$m=19456,t=2,p=1$…`), which carry their own parameters,
// so they can be raised later without breaking existing hashes.
import { hash, verify, type Options } from '@node-rs/argon2';

// algorithm 2 = Argon2id (the package's const enum cannot be imported under verbatimModuleSyntax).
const PARAMS: Options = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256; // bounds the hashing work an attacker can request

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

// A real hash of a random value: verifying against it costs the same as a real check, so a login for an
// unknown email takes as long as one with a wrong password (no account enumeration by timing).
let dummy: Promise<string> | undefined;

/** True only for the right password. `stored` null (no such user) still does the full amount of work. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX) return false;
  if (!stored) {
    dummy ??= hash(crypto.randomUUID(), PARAMS);
    await verify(await dummy, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}

/** Rules for a new password (invite acceptance, seed). Returns an error message or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  return null;
}
