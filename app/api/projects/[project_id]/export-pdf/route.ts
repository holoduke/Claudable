import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { denyUnlessProjectAccess } from '@/lib/auth/gate';
import { getProjectById } from '@/lib/services/project';
import { previewManager } from '@/lib/services/preview';

const execFileP = promisify(execFile);
const CHROMIUM = process.env.CHROMIUM_PATH || 'chromium';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/** Only a same-site path like "/" or "/quote.html" — never a full URL. */
function sanitizeSitePath(raw: string | null): string {
  const value = (raw || '/').trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('..')) return '/';
  return value;
}

/**
 * Export the project's RUNNING preview as a PDF (headless Chromium print, same
 * binary the thumbnails use). Works for any stack; built for the Document
 * (PDF/HTML) template where the page carries @page/A4 print CSS.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const denied = await denyUnlessProjectAccess(project_id);
    if (denied) return denied;

    const status = previewManager.getStatus(project_id);
    if (status.status !== 'running' || !status.port) {
      return NextResponse.json(
        { success: false, error: 'preview_not_running', message: 'Start the preview first — the PDF is rendered from the running preview.' },
        { status: 409 },
      );
    }

    const sitePath = sanitizeSitePath(new URL(request.url).searchParams.get('path'));
    const publishHost =
      (process.env.PREVIEW_PUBLISH_HOST || process.env.DEPLOY_HOST_GATEWAY || '').trim() || 'localhost';
    const url = `http://${publishHost}:${status.port}${sitePath}`;

    const tmp = path.join(os.tmpdir(), `claudable-pdf-${randomUUID().slice(0, 12)}.pdf`);
    try {
      await execFileP(
        CHROMIUM,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-pdf-header-footer',
          '--virtual-time-budget=5000',
          `--print-to-pdf=${tmp}`,
          url,
        ],
        { timeout: 45_000 },
      );
      const pdf = await fs.readFile(tmp);
      if (pdf.length === 0) throw new Error('empty PDF');

      const project = await getProjectById(project_id);
      const baseName = (project?.name || project_id).replace(/[^\w\s.-]/g, '').trim() || 'document';
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${baseName}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  } catch (error) {
    console.error('[API] PDF export failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'pdf_export_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
