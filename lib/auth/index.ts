import NextAuth from 'next-auth';
import { authConfig } from './config';
import Credentials from 'next-auth/providers/credentials';
import { isSignInAllowed, provisionUser } from './provision';
import { verifyLoginCode } from './email-code';
import { prisma } from '@/lib/db/client';

/**
 * Full Auth.js instance (Node runtime). Extends the Edge-safe config with
 * Prisma-backed callbacks: allowlist + provisioning on sign-in, and embedding
 * our app identity (id/role/orgId) into the JWT so the rest of the app can
 * authorize without a provider round-trip.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    // One-time e-mail code (for addresses without a Google account). The code
    // proves control of the mailbox; the signIn callback below still applies the
    // same allow-list and provisioning as for Google.
    Credentials({
      id: 'email-code',
      name: 'E-mail code',
      credentials: { email: { type: 'email' }, code: { type: 'text' } },
      async authorize(credentials) {
        const email = await verifyLoginCode(credentials?.email, credentials?.code);
        return email ? { email } : null;
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, profile }) {
      // Require a Google-VERIFIED email. Without this, the domain allowlist is
      // spoofable: anyone can create a personal Google account with the string
      // `someone@alloweddomain.com` (email_verified:false) and be provisioned a
      // real — possibly admin — account for an address they don't control.
      if (profile && profile.email_verified !== true) return false;
      const email = user.email?.toLowerCase();
      if (!email) return false;
      if (!(await isSignInAllowed(email))) return false; // -> /login?error=AccessDenied
      const provisioned = await provisionUser(email, user.name, user.image);
      return provisioned.isActive;
    },
    async jwt({ token, user }) {
      // Runs in Node (never on the Edge read path). Re-checked on every token
      // rotation — not just at sign-in — so deactivation and role changes take
      // effect without waiting for the token to expire. Returning null clears
      // the session cookie, which logs out a user who has been deactivated.
      const email = (user?.email ?? token.email)?.toLowerCase();
      if (!email) return token;
      const dbUser = await prisma.user.findUnique({
        where: { email },
        include: { _count: { select: { orgMemberships: true } } },
      });
      if (!dbUser || !dbUser.isActive) return null;
      // Removed from their last organisation → no tenant left to act in; end
      // the session instead of leaving a signed-in user who can see nothing.
      if (dbUser.role !== 'admin' && dbUser._count.orgMemberships === 0) return null;
      (token as any).uid = dbUser.id;
      (token as any).role = dbUser.role;
      (token as any).orgId = dbUser.orgId;
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
