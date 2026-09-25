import { NextResponse } from 'next/server';
import { getGitProviderConfig } from '@/lib/services/git-provider';
import { authEnabled, getSessionUser } from '@/lib/auth/session';
import { isInternalUser } from '@/lib/services/tenant-policy';

/**
 * Exposes the server's git provider configuration to the client so the Publish
 * UI can adapt (e.g. the self-hosted Gitea flow deploys via the Actions runner
 * and does not need Vercel). The internal git org and deploy domain are New
 * Story details: only staff get them, a customer-only user sees the provider.
 */
export async function GET() {
  const cfg = getGitProviderConfig();
  const internal = !authEnabled() || (await isInternalUser(await getSessionUser()));
  return NextResponse.json({
    success: true,
    provider: cfg.provider,
    ...(internal ? { deployDomain: cfg.deployDomain, org: cfg.org } : {}),
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
