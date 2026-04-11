import { NextResponse } from 'next/server';
import { clearClaudeSession } from '@/lib/services/cli/claude-session-commands';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const result = await clearClaudeSession(project_id);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to clear Claude session';
    const status = message.includes('Project not found')
      ? 404
      : message.includes('No active Claude session') || message.includes('only available')
      ? 409
      : message.includes('Security violation')
      ? 400
      : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
