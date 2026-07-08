import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth/config';

// Edge-safe instance (config has no Prisma) — used only to verify the session JWT.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  // Safety valve: until AUTH_ENABLED=true the gate is off and the app behaves as
  // before, so a misconfigured login can never lock everyone out.
  if (process.env.AUTH_ENABLED !== 'true') return;

  const { pathname } = req.nextUrl;

  // Static files (favicon, /public images, fonts) must load even for an
  // unauthenticated visitor so the /login page renders. Only for NON-API paths —
  // an /api/*.js path must never skip the gate (that was the extension bypass).
  if (!pathname.startsWith('/api/') && /\.(?:png|jpe?g|svg|gif|webp|ico|css|js|map|woff2?|ttf|otf)$/i.test(pathname)) {
    return;
  }

  const isPublic =
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/api/auth') ||
    pathname === '/api/health' ||
    // Public stakeholder-review surface (the token is the credential).
    pathname === '/share' ||
    pathname.startsWith('/share/') ||
    pathname.startsWith('/api/share/') ||
    // Network-MCP for the containerized agent — the unguessable per-turn token
    // in the path is the credential; the handler validates + revokes it.
    pathname.startsWith('/api/agent-mcp/') ||
    // MCP OAuth callback — the provider redirects the user's browser here; the
    // single-use unguessable `state` (matched to a pending server row) is the
    // credential, so it must be reachable regardless of the session cookie.
    pathname === '/api/mcp-oauth/callback' ||
    // Guest review endpoints — the handlers self-authorize (X-Share-Token for
    // comments; client-logs is intentionally open preview telemetry). A signed-in
    // user still needs a session there; passing them through here is safe.
    /^\/api\/projects\/[^/]+\/(comments|client-logs)$/.test(pathname);

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
  // Run on everything except Next internals. Static-asset skipping is handled
  // INSIDE the function (non-API only) so /api can never be bypassed by a path
  // that merely contains a static extension.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
