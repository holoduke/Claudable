/**
 * POST /api/auth/email-code  { email }
 * Sends a one-time sign-in code to an address that may sign in. The answer is
 * the same whether or not a code was sent (no account enumeration).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requestLoginCode } from '@/lib/auth/email-code';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The reverse proxy APPENDS the address it saw: the last entry is the real
// client, earlier ones are whatever the client claimed.
function clientIp(req: NextRequest): string {
  const chain = (req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - 1] || req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  try {
    await requestLoginCode(body?.email, clientIp(req));
  } catch (error) {
    console.error('[email-code] request failed:', error);
  }
  return NextResponse.json({ success: true });
}
