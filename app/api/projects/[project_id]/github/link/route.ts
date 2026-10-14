/**
 * POST /api/projects/:id/github/link  -> { repo: "owner/name", push_mode?: "direct" | "pr", force?: true }
 * Links the project to an EXISTING github.com repository. Superadmin only: the
 * GitHub App can reach every repo it is installed on, so choosing which repo a
 * project publishes to is not something a project manager may do.
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { GitHubError } from '@/lib/services/github';
import { linkProjectToGithubRepo, parseGithubRepo } from '@/lib/services/github-link';
import { createErrorResponse, createSuccessResponse } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const admin = await getAdminUser();
  if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
  const { project_id } = await params;
  const body = (await request.json().catch(() => null)) ?? {};
  const parsed = parseGithubRepo(typeof body.repo === 'string' ? body.repo : '');
  if (!parsed) return createErrorResponse('invalid_repo', 'Enter the repository as owner/name, e.g. new-story/storyloop.', 400);
  const pushMode = body.push_mode === 'pr' ? 'pr' : 'direct';
  try {
    const force = body.force === true;
    return createSuccessResponse(await linkProjectToGithubRepo(project_id, { ...parsed, pushMode, force }));
  } catch (error) {
    if (error instanceof GitHubError) return createErrorResponse('github_link', error.message, error.status ?? 500);
    console.error('[GitHub link API]', error instanceof Error ? error.message : error);
    return createErrorResponse('github_link', 'Could not link the repository', 500);
  }
}
