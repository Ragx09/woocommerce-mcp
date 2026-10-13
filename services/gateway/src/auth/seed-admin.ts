// AUTH-02: the first admin comes from Secret `gateway-admin` (ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME).
// Created only while the database has no admin at all; it never overwrites a user, so a password changed
// later is kept and the Secret is only the bootstrap value.
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword, passwordProblem } from './password.js';

export interface AdminSeed { email: string; name: string; password: string }
export type AdminSeedResult = 'created' | 'exists';

const LOCK_ID = '7400183212'; // advisory lock shared by replicas (differs from the migration and upstream seed locks)

export function loadAdminSeed(env: NodeJS.ProcessEnv = process.env): AdminSeed | null {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD ?? '';
  if (!email) return null;
  const problem = passwordProblem(password);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  return { email, name: env.ADMIN_NAME?.trim() || 'Admin', password };
}

export async function seedAdmin(db: Db, seed: AdminSeed): Promise<AdminSeedResult> {
  const passwordHash = await hashPassword(seed.password); // outside the transaction: ~50 ms of CPU
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_ID})`);
    const [admin] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
    if (admin) return 'exists';
    await tx.insert(users).values({ email: seed.email, name: seed.name, role: 'admin', passwordHash })
      .onConflictDoUpdate({ target: users.email, set: { role: 'admin' } }); // a member with that email is promoted, password kept
    return 'created';
  });
}
