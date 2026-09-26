import type { NextRequest } from 'next/server';
import { branchRoute } from '@/lib/services/git-branch-route';
import { createProjectBranch, listProjectBranches } from '@/lib/services/git-branches';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/** The project's branches (local + remote), the current one and the base ("main"). */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  return branchRoute(request, project_id, { write: false }, () => listProjectBranches(project_id));
}

/** Create a branch from the current state and switch to it. Body: { name }. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  const body = (await request.json().catch(() => null)) ?? {};
  return branchRoute(request, project_id, { write: true }, () => createProjectBranch(project_id, body.name));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
