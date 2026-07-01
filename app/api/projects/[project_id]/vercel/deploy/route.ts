import { NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { triggerVercelDeployment } from '@/lib/services/vercel';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const _gate = await denyUnlessProjectAccess(project_id);
    if (_gate) return _gate;
    const result = await triggerVercelDeployment(project_id);
    return NextResponse.json({
      success: true,
      deployment_id: result.deploymentId ?? null,
      deployment_url: result.deploymentUrl ?? null,
      status: result.status ?? null,
    });
  } catch (error) {
    console.error('[API] Failed to trigger Vercel deployment:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to trigger Vercel deployment',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
