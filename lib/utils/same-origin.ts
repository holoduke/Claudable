import type { NextRequest } from 'next/server';

/** Reject cross-site requests: Origin (or Referer) must be this host. */
export function isSameOrigin(request: NextRequest): boolean {
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (!host || !source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}
