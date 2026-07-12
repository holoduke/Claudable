/**
 * External-service types shared by client and server (GitHub, Vercel, and the
 * service-connection base types they build on). The former project/cli/chat
 * entries were unused duplicates of the canonical defs in `types/backend`
 * (server) and `types/` root (client) — removed 2026-07-12.
 */

export * from './service';
export * from './github';
export * from './vercel';
