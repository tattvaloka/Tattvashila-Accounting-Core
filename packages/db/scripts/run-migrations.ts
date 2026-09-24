/**
 * Applies migrations/*.sql, in filename order, inside a single connection.
 * These are hand-authored SQL files (see migrations/0000_init.sql for why),
 * so this script is a plain runner rather than drizzle-kit's migrator.
 *
 * Usage: npm run migrate   (reads DATABASE_URL from .env)
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
  }

  const migrationsDir = join(__dirname, '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const file of files) {
      console.log(`Applying ${file} ...`);
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query(sql);
      console.log(`  done.`);
    }
    console.log('All migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
