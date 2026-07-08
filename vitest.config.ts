import { defineConfig } from 'vitest/config';
import path from 'path';

// Unit tests run in a plain Node env over the pure (no DB/network/React) units.
// The `@/…` alias mirrors tsconfig so imports resolve the same way as the app.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['lib/**/*.test.ts', 'tests/**/*.test.ts'],
    // Prisma 7's driver adapter resolves DATABASE_URL when lib/db/client.ts
    // is imported (transitively, via service modules). Tests mock the DB and
    // never open a connection, so any syntactically valid value works.
    env: {
      DATABASE_URL: 'file:../data/vitest-unused.db',
    },
  },
});
