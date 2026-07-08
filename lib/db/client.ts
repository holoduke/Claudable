import path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

// Prisma Client singleton pattern for Next.js
// Prevents multiple instances in development (hot reload)

const globalForPrisma = global as unknown as {
  prisma: PrismaClient;
  staleRequestsReconciled?: boolean;
};

/**
 * Prisma <=6 resolved a relative `file:` DATABASE_URL against the prisma/
 * directory; the better-sqlite3 adapter resolves against the process cwd.
 * Re-anchor relative paths to prisma/ so existing .env values (e.g.
 * "file:../data/cc.db") keep pointing at the same database file.
 */
function resolveSqliteUrl(rawUrl: string | undefined): string {
  if (!rawUrl) {
    throw new Error('DATABASE_URL is not configured');
  }
  const filePath = rawUrl.replace(/^file:/, '');
  if (path.isAbsolute(filePath)) {
    return `file:${filePath}`;
  }
  return `file:${path.resolve(process.cwd(), 'prisma', filePath)}`;
}

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: resolveSqliteUrl(process.env.DATABASE_URL) }),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Crash recovery: reconcile zombie in-flight requests left by a previous
 * process. A request is driven entirely in-process (running -> completed/failed
 * in a finally block); if the process is killed mid-run (container redeploy),
 * that finally never runs and the row stays "running" forever, permanently
 * flagging the project as busy.
 *
 * This runs once per server process, the first time the Prisma client is
 * imported on the server. We do it here rather than in instrumentation.ts
 * because `next start` with `output: 'standalone'` skips the instrumentation
 * hook, so this is the only launch-mode-independent place that always runs.
 */
if (typeof window === 'undefined' && !globalForPrisma.staleRequestsReconciled) {
  globalForPrisma.staleRequestsReconciled = true;
  prisma.userRequest
    .updateMany({
      where: { status: { in: ['pending', 'processing', 'active', 'running'] } },
      data: {
        status: 'failed',
        errorMessage: 'Interrupted by a server restart',
        completedAt: new Date(),
      },
    })
    .then((result) => {
      if (result.count > 0) {
        console.log(
          `[StartupRecovery] Reconciled ${result.count} stale request(s) left running after restart`,
        );
      }
    })
    .catch((error) => {
      console.error('[StartupRecovery] Failed to reconcile stale requests:', error);
    });
}
