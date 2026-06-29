import NextAuth from 'next-auth';
import { authConfig } from './config';
import { isSignInAllowed, provisionUser } from './provision';
import { prisma } from '@/lib/db/client';

/**
 * Full Auth.js instance (Node runtime). Extends the Edge-safe config with
 * Prisma-backed callbacks: allowlist + provisioning on sign-in, and embedding
 * our app identity (id/role/orgId) into the JWT so the rest of the app can
 * authorize without a provider round-trip.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      if (!(await isSignInAllowed(email))) return false; // -> /login?error=AccessDenied
      const provisioned = await provisionUser(email, user.name, user.image);
      return provisioned.isActive;
    },
    async jwt({ token, user }) {
      // Only on sign-in (user present) — runs in Node, never on the Edge read path.
      const email = (user?.email ?? token.email)?.toLowerCase();
      if (user && email) {
        const dbUser = await prisma.user.findUnique({ where: { email } });
        if (dbUser) {
          (token as any).uid = dbUser.id;
          (token as any).role = dbUser.role;
          (token as any).orgId = dbUser.orgId;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = (token as any).uid;
        (session.user as any).role = (token as any).role;
        (session.user as any).orgId = (token as any).orgId;
      }
      return session;
    },
  },
});
