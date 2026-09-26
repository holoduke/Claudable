/**
 * Completely wipe a project (Project settings → General → Danger zone).
 *
 * GET  → the wipe plan (what will be removed, what is skipped and why).
 * POST → { confirmName, deleteDatabase?, deleteRemoteRepo? } performs the wipe.
 *
 * Security: owner/admin only (`manage`; on customer projects New Story staff only),
 * same-origin requests only, and the exact project name must be typed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getSessionUser } from '@/lib/auth/session';
import { isSameOrigin } from '@/lib/utils/same-origin';
import { planWipe, wipeProject } from '@/lib/services/project-wipe';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const sameOrigin = isSameOrigin;

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  if (!PROJECT_ID_RE.test(project_id)) return NextResponse.json({ success: false, error: 'Invalid project id' }, { status: 400 });
  const denied = await denyUnlessProjectAccess(project_id, { manage: true });
  if (denied) return denied;
  try {
    const plan = await planWipe(project_id);
    return NextResponse.json({ success: true, data: plan });
  } catch (error) {
    console.error('[API] wipe plan failed:', error);
    return NextResponse.json({ success: false, error: 'Could not prepare the wipe' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  if (!PROJECT_ID_RE.test(project_id)) return NextResponse.json({ success: false, error: 'Invalid project id' }, { status: 400 });
  if (!sameOrigin(request)) return NextResponse.json({ success: false, error: 'Cross-site request refused' }, { status: 403 });
  const denied = await denyUnlessProjectAccess(project_id, { manage: true });
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const plan = await planWipe(project_id);
    if (typeof body.confirmName !== 'string' || body.confirmName !== plan.project.name) {
      return NextResponse.json({ success: false, error: 'Type the exact project name to confirm.' }, { status: 400 });
    }
    const user = await getSessionUser();
    const report = await wipeProject(
      project_id,
      { deleteDatabase: body.deleteDatabase === true, deleteRemoteRepo: body.deleteRemoteRepo === true },
      user ? { id: user.id, email: user.email } : null,
    );
    return NextResponse.json({
      success: true,
      data: { removed: report.removed, failed: report.failed, skipped: report.plan.skipped },
    });
  } catch (error) {
    console.error('[API] wipe failed:', error);
    const message = error instanceof Error ? error.message : 'Wipe failed';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
