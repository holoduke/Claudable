import { NextResponse, type NextRequest } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { projectContainerStats } from '@/lib/services/container-stats';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/** Live CPU/memory of this project's containers (panel rows: frontend, backend, service ids). */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  const gate = await denyUnlessProjectAccess(project_id);
  if (gate) return gate;
  try {
    return NextResponse.json({ success: true, stats: await projectContainerStats(project_id) });
  } catch (error) {
    console.error('[API] container stats failed:', error);
    return NextResponse.json({ success: false, stats: {} }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
