import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

/**
 * Edge-safe Auth.js config (NO Prisma / Node-only imports). Used by middleware
 * to verify the session JWT on the Edge runtime. The full config in ./index.ts
 * extends this with Prisma-backed callbacks for the (Node) route handler.
 */
export const authConfig = {
  // Self-hosted behind a reverse proxy — trust the configured AUTH_URL host.
  trustHost: true,
  // 8h lifetime bounds how long the pure-Edge page gate can trust a stale token
  // (the Node jwt callback revokes deactivated users sooner on any API/session hit).
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8 },
  pages: { signIn: '/login', error: '/login' },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Always show the account chooser so people can pick the right account.
      authorization: { params: { prompt: 'select_account' } },
    }),
  ],
  callbacks: {
    // Edge-safe: middleware only needs "is there a valid session".
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;
