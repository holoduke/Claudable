/**
 * GitHub App credentials Claudable pushes to github.com with (superadmin only).
 *   GET    -> status (never the key)
 *   PUT    -> { app_id, private_key } validated against GitHub, then stored encrypted
 *   DELETE -> remove the stored App (env config, if any, takes over)
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { GitHubAppError, deleteGitHubApp, getGitHubAppStatus, saveGitHubApp } from '@/lib/services/github-app';
import { createErrorResponse, createSuccessResponse } from '@/lib/utils/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failure(error: unknown, fallback: string) {
  if (error instanceof GitHubAppError) return createErrorResponse('github_app', error.message, error.status);
  console.error('[GitHub App API]', fallback, error instanceof Error ? error.message : error);
  return createErrorResponse('github_app', fallback, 500);
}

export async function GET() {
  const admin = await getAdminUser();
  if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
  try {
    return createSuccessResponse(await getGitHubAppStatus());
  } catch (error) {
    return failure(error, 'Could not read the GitHub App status');
  }
}

export async function PUT(request: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
  const body = (await request.json().catch(() => null)) ?? {};
  const appId = typeof body.app_id === 'string' || typeof body.app_id === 'number' ? String(body.app_id) : '';
  const privateKey = typeof body.private_key === 'string' ? body.private_key : '';
  try {
    return createSuccessResponse(await saveGitHubApp(appId, privateKey, admin.email));
  } catch (error) {
    return failure(error, 'Could not save the GitHub App');
  }
}

export async function DELETE() {
  const admin = await getAdminUser();
  if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
  try {
    return createSuccessResponse(await deleteGitHubApp());
  } catch (error) {
    return failure(error, 'Could not remove the GitHub App');
  }
}
