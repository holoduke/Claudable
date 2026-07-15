/**
 * Project thumbnail.
 *   GET  /api/projects/:id/thumbnail  -> the PNG (304/404 when absent)
 *   POST /api/projects/:id/thumbnail  -> capture from the running preview
 */
import { NextRequest, NextResponse } from 'next/server';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getThumbnail, captureThumbnail } from '@/lib/services/thumbnail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ project_id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { project_id } = await params;
  const _gate = await denyUnlessProjectAccess(project_id);
  if (_gate) return _gate;
  const thumb = await getThumbnail(project_id);
  if (!thumb) {
    return NextResponse.json({ success: false, error: 'No thumbnail' }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(thumb.buffer), {
    status: 200,
    headers: {
      'Content-Type': thumb.contentType,
      // The tile URL carries a ?v=<thumbsVersion> that the homepage bumps whenever
      // thumbnails are refreshed, so we can cache hard and let the version param
      // bust it — instead of re-downloading every screenshot every 60s (the old
      // max-age=60 was the main homepage slowdown). stale-while-revalidate keeps
      // tiles instant while a fresher shot loads in the background.
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}

export async function POST(_req: NextRequest, { params }: Ctx) {
  const { project_id } = await params;
  const _gate = await denyUnlessProjectAccess(project_id);
  if (_gate) return _gate;
  const ok = await captureThumbnail(project_id);
  return NextResponse.json({ success: ok }, { status: ok ? 200 : 202 });
}
