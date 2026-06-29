/**
 * Project thumbnail.
 *   GET  /api/projects/:id/thumbnail  -> the PNG (304/404 when absent)
 *   POST /api/projects/:id/thumbnail  -> capture from the running preview
 */
import { NextRequest, NextResponse } from 'next/server';
import { getThumbnail, captureThumbnail } from '@/lib/services/thumbnail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ project_id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { project_id } = await params;
  const png = await getThumbnail(project_id);
  if (!png) {
    return NextResponse.json({ success: false, error: 'No thumbnail' }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // Short cache: thumbnails update as the project changes.
      'Cache-Control': 'public, max-age=60',
    },
  });
}

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { project_id } = await params;
  const ok = await captureThumbnail(project_id);
  return NextResponse.json({ success: ok }, { status: ok ? 200 : 202 });
}
