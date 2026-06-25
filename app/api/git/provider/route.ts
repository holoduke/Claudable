import { NextResponse } from 'next/server';
import { getGitProviderConfig } from '@/lib/services/git-provider';

/**
 * Exposes the server's git provider configuration to the client so the Publish
 * UI can adapt (e.g. the self-hosted Gitea flow deploys via the Actions runner
 * and does not need Vercel).
 */
export async function GET() {
  const cfg = getGitProviderConfig();
  return NextResponse.json({
    success: true,
    provider: cfg.provider,
    deployDomain: cfg.deployDomain,
    org: cfg.org,
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
