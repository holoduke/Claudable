/**
 * Design Explorer — generation. Each frame is produced by running the SAME
 * hardened, socket-less agent container used for chat turns
 * (`runAgentTurnContainerized`), but pointed at a throwaway SCRATCH dir instead
 * of the project repo. So generation can't touch the project, needs no
 * checkpoint/preview/MCP plumbing, and stays fully isolated. Frames are
 * generated with bounded concurrency to protect the shared box, and each
 * finished frame is persisted then published over the project SSE.
 */
import fs from 'fs/promises';
import path from 'path';
import {
  runAgentTurnContainerized,
  defaultAgentSandboxNet,
  agentHostPath,
} from '@/lib/services/cli/claude-container';
import { resolveProjectClaudeToken } from '@/lib/services/claude-credentials';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { prisma } from '@/lib/db/client';
import { streamManager } from '@/lib/services/stream';
import { serializeDesignFrame } from '@/lib/serializers/design-explorer';
import { readDesignSpec } from './styles';

/** Max design containers in flight at once — keeps 3×(1g/1cpu) on the shared box. */
const MAX_CONCURRENT = Math.max(1, Number.parseInt(process.env.DESIGN_MAX_CONCURRENT || '', 10) || 3);
const FRAME_TIMEOUT_MS = 4 * 60_000;

/** Absolute scratch dir for a frame (under data/ so agentHostPath resolves it). */
export function frameScratchDir(canvasId: string, frameId: string): string {
  return path.resolve(process.cwd(), 'data', 'design-canvases', canvasId, frameId);
}

const SYSTEM_PROMPT = [
  'You are a senior product designer. You produce a SINGLE self-contained HTML mockup of a web page.',
  'Hard rules:',
  '- Write EXACTLY ONE file named `index.html` in the current working directory. No other files, no build step.',
  '- Use Tailwind via the CDN: <script src="https://cdn.tailwindcss.com"></script>. Google Fonts via <link> is allowed.',
  '- The page must be a complete, realistic, visually polished mockup with sensible placeholder content (headings, nav, sections, buttons, cards, footer) — not a skeleton.',
  '- Inline everything; do not reference local files or images (use inline SVG, emoji, or picsum.photos URLs for imagery).',
  '- Do NOT explain anything in chat. Just create index.html.',
].join('\n');

function framePrompt(brief: string, styleSpec: string | null, styleName: string | null): string {
  const parts = [`Design brief: ${brief}`, ''];
  if (styleSpec) {
    parts.push(
      `Apply this design direction${styleName ? ` ("${styleName}")` : ''} — adopt its palette, typography, spacing and overall feel:`,
      '',
      styleSpec.slice(0, 4000),
    );
  } else if (styleName) {
    parts.push(`Design direction: ${styleName}.`);
  }
  parts.push('', 'Create `index.html` now.');
  return parts.join('\n');
}

async function publishFrame(projectId: string, frameId: string): Promise<void> {
  const frame = await prisma.designFrame.findUnique({ where: { id: frameId } });
  if (!frame) return;
  const s = serializeDesignFrame(frame);
  streamManager.publish(projectId, {
    type: 'design_frame',
    data: {
      canvasId: frame.canvasId,
      frame: {
        id: s.id,
        canvasId: s.canvasId,
        styleId: s.styleId,
        styleName: s.styleName,
        status: s.status,
        version: s.version,
        parentFrameId: s.parentFrameId,
        hasHtml: s.hasHtml,
        errorText: s.errorText,
        updatedAt: s.updatedAt,
      },
    },
  });
}

/** Read the mockup the agent wrote — index.html, else the first *.html in the dir. */
async function readGeneratedHtml(dir: string): Promise<string | null> {
  const indexPath = path.join(dir, 'index.html');
  try {
    const html = await fs.readFile(indexPath, 'utf8');
    if (html.trim()) return html;
  } catch { /* fall through */ }
  try {
    const entries = await fs.readdir(dir);
    const htmlFile = entries.find((e) => e.toLowerCase().endsWith('.html'));
    if (htmlFile) {
      const html = await fs.readFile(path.join(dir, htmlFile), 'utf8');
      if (html.trim()) return html;
    }
  } catch { /* none */ }
  return null;
}

/**
 * Generate one frame end-to-end: run the container against a scratch dir, store
 * the produced HTML on disk, and update + publish the row. Never throws — a
 * failed frame is recorded as status `error` so the board can show it.
 */
export async function generateFrame(
  projectId: string,
  frameId: string,
  requesterUserId?: string,
): Promise<void> {
  const frame = await prisma.designFrame.findUnique({ where: { id: frameId } });
  if (!frame) return;

  await prisma.designFrame.update({ where: { id: frameId }, data: { status: 'generating' } });
  await publishFrame(projectId, frameId);

  const scratch = frameScratchDir(frame.canvasId, frameId);
  try {
    await fs.mkdir(scratch, { recursive: true });
    const oauthToken =
      (await resolveProjectClaudeToken(projectId, requesterUserId)) ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      '';
    if (!oauthToken) throw new Error('No Claude credential available for design generation');

    const styleSpec = frame.styleId ? await readDesignSpec(frame.styleId) : null;
    const model = normalizeModelId('claude', getDefaultModelForCli('claude'));

    const { done } = runAgentTurnContainerized(
      {
        projectHostPath: agentHostPath(scratch),
        prompt: framePrompt(frame.prompt, styleSpec, frame.styleName),
        oauthToken,
        model,
        systemPrompt: SYSTEM_PROMPT,
        sandboxNet: defaultAgentSandboxNet(),
        containerName: `claudable-design-${frameId}`,
        memory: '1g',
        cpus: '1.0',
        timeoutMs: FRAME_TIMEOUT_MS,
      },
      () => { /* per-event streaming not needed; we publish on completion */ },
    );
    const result = await done;

    const html = await readGeneratedHtml(scratch);
    if (!html) {
      throw new Error(result.error || 'Agent produced no HTML');
    }
    const htmlPath = path.join(scratch, 'index.html');
    await fs.writeFile(htmlPath, html, 'utf8'); // normalize to index.html
    await prisma.designFrame.update({
      where: { id: frameId },
      data: { status: 'ready', htmlPath, errorText: null },
    });
  } catch (error) {
    await prisma.designFrame.update({
      where: { id: frameId },
      data: { status: 'error', errorText: error instanceof Error ? error.message.slice(0, 500) : 'Generation failed' },
    });
  }
  await publishFrame(projectId, frameId);
}

/** Run `frameIds` through generateFrame with bounded concurrency. */
export async function generateFrames(
  projectId: string,
  frameIds: string[],
  requesterUserId?: string,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < frameIds.length) {
      const id = frameIds[cursor++];
      await generateFrame(projectId, id, requesterUserId);
    }
  };
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, frameIds.length) }, () => worker());
  await Promise.all(workers);

  // Mark the canvas ready once all its frames have settled.
  const canvasId = (await prisma.designFrame.findUnique({ where: { id: frameIds[0] }, select: { canvasId: true } }))?.canvasId;
  if (canvasId) {
    await prisma.designCanvas.update({ where: { id: canvasId }, data: { status: 'ready' } }).catch(() => {});
  }
}
