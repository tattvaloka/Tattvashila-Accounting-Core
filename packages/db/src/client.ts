import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooled connection string generally wants SSL in production;
  // uncomment the line below once you're pointed at a real Supabase project.
  // ssl: { rejectUnauthorized: false },
});

export const db = drizzle(pool, { schema });

/**
 * Sets the tenant context for the current connection/transaction. The
 * Express middleware layer must call this (inside the same DB transaction
 * as the request it belongs to) immediately after verifying the caller's
 * JWT — org_id must NEVER come from the request body. This is what makes
 * the RLS policies in migrations/0000_init.sql actually apply. See
 * "Tenant-Consistency Strategy" / "RLS Strategy" in the design doc.
 *
 * Not wired into any route yet — Milestone 2 is schema only. This helper
 * exists so the convention is documented next to the schema it protects.
 */
export async function withOrgContext<T>(
  organizationId: string,
  fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Parameterized via drizzle's sql tag — never string-interpolate this,
    // since organizationId ultimately traces back to a request.
    await tx.execute(sql`select set_config('app.current_org_id', ${organizationId}, true)`);
    return fn(tx as unknown as typeof db);
  });
}
