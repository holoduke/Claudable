import 'dotenv/config';
import path from 'path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads the connection URL from schema.prisma or loads
// .env automatically; the CLI (db push, migrate, studio) gets it from here.
// The runtime client gets its connection via the better-sqlite3 adapter in
// lib/db/client.ts.
//
// Prisma <=6 resolved a relative `file:` DATABASE_URL against the prisma/
// directory, but the v7 CLI resolves it against this config file's directory.
// Re-anchor relative paths to prisma/ so existing .env values (e.g.
// "file:../data/cc.db") keep pointing at the same database file.
function resolveSqliteUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    throw new Error('DATABASE_URL is not configured');
  }
  const filePath = rawUrl.replace(/^file:/, '');
  if (path.isAbsolute(filePath)) {
    return `file:${filePath}`;
  }
  return `file:${path.resolve(__dirname, 'prisma', filePath)}`;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: resolveSqliteUrl(process.env.DATABASE_URL),
  },
});
