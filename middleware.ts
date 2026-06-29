import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth/config';

// Edge-safe instance (config has no Prisma) — used only to verify the session JWT.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  // Safety valve: until AUTH_ENABLED=true the gate is off and the app behaves as
  // before, so a misconfigured login can never lock everyone out.
  if (process.env.AUTH_ENABLED !== 'true') return;

  const { pathname } = req.nextUrl;
  const isPublic =
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/health');

  if (req.auth || isPublic) return;

  // API calls get a 401; page navigations get redirected to the login page.
  if (pathname.startsWith('/api/')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return Response.redirect(url);
});

export const config = {
  // Run on everything except Next internals and static asset files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|svg|gif|webp|ico|css|js|woff2?|ttf|otf)).*)'],
};
