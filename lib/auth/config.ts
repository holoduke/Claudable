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
  session: { strategy: 'jwt' },
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
