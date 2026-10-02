import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getServiceTokenStatus } from '@/lib/services/token-status';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * GET /api/projects/:id/services/token-status
 * → { providers: { github: { configured }, supabase: {…}, vercel: {…} }, can_manage_tokens }
 *
 * The admin-only /api/tokens/:provider made the Deploy tab show "Token needed"
 * to every non-admin owner (403 read as "no token"). This returns booleans only
 * — no token values, names or ids — to anyone who may write the project.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id, { write: true });
    if (denied) return denied;
    return NextResponse.json(await getServiceTokenStatus());
  } catch (error) {
    console.error('[API] Failed to load service token status:', error);
    return NextResponse.json(
      { success: false, error: 'token_status_failed', message: 'Could not check service tokens' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
