import type { NextRequest } from 'next/server';
import { branchRoute } from '@/lib/services/git-branch-route';
import { mergeProjectBranchIntoBase } from '@/lib/services/git-branches';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * Merge the current branch into the base branch. With a remote this publishes
 * the branch and merges a pull request on the repo host (which then deploys).
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  return branchRoute(request, project_id, { write: true }, () => mergeProjectBranchIntoBase(project_id));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
