import { Pool } from 'pg'

export function testDb(): Pool {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set — run scripts/test-db-up.sh first')
  return new Pool({ connectionString: url })
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE bridge_audit, bridge_pairing_tokens, bridge_devices, users CASCADE')
}
