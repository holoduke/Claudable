import type { NextRequest } from 'next/server';
import { branchRoute } from '@/lib/services/git-branch-route';
import { switchProjectBranch } from '@/lib/services/git-branches';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/** Switch the project to another branch. Body: { branch }. Pending work is committed first. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  const body = (await request.json().catch(() => null)) ?? {};
  return branchRoute(request, project_id, { write: true }, () => switchProjectBranch(project_id, body.branch));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
