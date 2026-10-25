// D-026: the provisioner logs in to Postgres as its own role, created NOLOGIN by migration 0006 with SELECT on
// a few columns of `stores` only. Its password comes from a Secret; the gateway (database owner) applies it at
// every start, so rotating the Secret and restarting is all a rotation needs.
import pg from 'pg';

export async function setProvisionerPassword(pool: pg.Pool, password: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(password)) throw new Error('PROVISIONER_DB_PASSWORD must be 24–128 characters of [A-Za-z0-9_-]');
  const client = await pool.connect();
  try {
    // ALTER ROLE takes no bind parameters; the value is a quoted literal of a restricted alphabet.
    await client.query(`ALTER ROLE provisioner LOGIN PASSWORD ${client.escapeLiteral(password)}`);
  } finally {
    client.release();
  }
}
