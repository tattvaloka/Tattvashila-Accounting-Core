import { defineConfig } from 'vitest/config';
import 'dotenv/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests self-skip without DATABASE_URL (see
    // test/sales.integration.test.ts) rather than being excluded here, so
    // `npm test` behaves correctly both with and without a database
    // configured. The dotenv import above picks up .env in this package
    // directory so DATABASE_URL is visible to process.env here too.
    include: ['test/**/*.test.ts'],
  },
});
