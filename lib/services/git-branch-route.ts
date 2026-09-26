import { NextResponse, type NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { isSameOrigin } from '@/lib/utils/same-origin';

/** Shared plumbing for the /git/* branch routes: access gate + error envelope. */
export async function branchRoute<T extends object>(
  request: NextRequest,
  projectId: string,
  opts: { write: boolean },
  fn: () => Promise<T>,
): Promise<Response> {
  try {
    if (opts.write && !isSameOrigin(request)) {
      return NextResponse.json({ success: false, message: 'Cross-site request refused' }, { status: 403 });
    }
    const gate = await denyUnlessProjectAccess(projectId, opts.write ? { write: true } : undefined);
    if (gate) return gate;
    return NextResponse.json({ success: true, ...(await fn()) });
  } catch (error) {
    const status = error instanceof Error && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : 500;
    if (status >= 500) console.error('[API] git branch operation failed:', error);
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : 'Unknown error' },
      { status },
    );
  }
}
