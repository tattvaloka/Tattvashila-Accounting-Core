import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Used by `drizzle-kit generate` / `drizzle-kit studio` going forward, once
// this baseline has been applied by scripts/run-migrations.ts. See
// README.md for why Milestone 2 ships hand-authored SQL instead of a
// drizzle-kit-generated migration.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
