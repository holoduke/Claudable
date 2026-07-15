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

/** Max design containers in flight at once — keeps 3×(1g/1cpu) on the shared box.
 *  This is a GLOBAL cap across all canvases/requests (not per-call), so N
 *  simultaneous "Generate" clicks can't multiply container load. */
const MAX_CONCURRENT = Math.max(1, Number.parseInt(process.env.DESIGN_MAX_CONCURRENT || '', 10) || 3);
const FRAME_TIMEOUT_MS = 4 * 60_000;

// --- Global admission semaphore (shared by every generateFrames call) --------
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (activeSlots < MAX_CONCURRENT) { activeSlots += 1; return; }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
  activeSlots += 1;
}
function releaseSlot(): void {
  activeSlots -= 1;
  const next = slotWaiters.shift();
  if (next) next();
}

// Abort handles for in-flight frames so a canvas delete can hard-stop the
// containers instead of orphaning them (they'd keep burning cost + resources).
const inflight = new Map<string, () => void>();
/** Hard-stop any still-running generation for these frame ids. */
export function cancelFrames(frameIds: string[]): void {
  for (const id of frameIds) {
    const abort = inflight.get(id);
    if (abort) { try { abort(); } catch { /* already gone */ } inflight.delete(id); }
  }
}

/** Update a frame row, ignoring the "record deleted" race (canvas was removed
 *  mid-generation) so a cancelled turn doesn't throw an untracked rejection. */
async function safeUpdateFrame(frameId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await prisma.designFrame.update({ where: { id: frameId }, data });
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2025') throw e; // P2025 = row gone (deleted)
  }
}

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

function framePrompt(brief: string, styleSpec: string | null, styleName: string | null, hasReference: boolean): string {
  const parts = [`Design brief: ${brief}`, ''];
  if (hasReference) {
    parts.push('A reference image is provided at ./reference (read it first) — match its overall visual style, layout, palette and mood.', '');
  }
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

/** Extract usage/cost from the CLI's final `result` stream-json event. */
interface CapturedUsage { costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number; }
function captureUsage(evt: Record<string, unknown>, sink: CapturedUsage): void {
  if (evt?.type !== 'result') return;
  if (typeof evt.total_cost_usd === 'number') sink.costUsd = evt.total_cost_usd;
  if (typeof evt.duration_ms === 'number') sink.durationMs = evt.duration_ms;
  const usage = evt.usage as Record<string, unknown> | undefined;
  if (usage) {
    if (typeof usage.input_tokens === 'number') sink.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') sink.outputTokens = usage.output_tokens;
  }
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

  // Wait for a global slot (bounds total containers across all requests). Stay
  // `pending` while queued so the UI doesn't claim "generating" prematurely.
  await acquireSlot();
  await safeUpdateFrame(frameId, { status: 'generating' });
  await publishFrame(projectId, frameId);

  const scratch = frameScratchDir(frame.canvasId, frameId);
  try {
    await fs.mkdir(scratch, { recursive: true });
    const oauthToken =
      (await resolveProjectClaudeToken(projectId, requesterUserId)) ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      '';
    if (!oauthToken) throw new Error('No Claude credential available for design generation');

    // Copy the canvas's reference image into the scratch so the agent can read it.
    const canvas = await prisma.designCanvas.findUnique({ where: { id: frame.canvasId }, select: { referenceImagePath: true } });
    let hasReference = false;
    if (canvas?.referenceImagePath) {
      const ext = path.extname(canvas.referenceImagePath) || '.png';
      await fs.copyFile(canvas.referenceImagePath, path.join(scratch, `reference${ext}`)).then(() => { hasReference = true; }).catch(() => {});
    }

    const styleSpec = frame.styleId ? await readDesignSpec(frame.styleId) : null;
    const model = normalizeModelId('claude', getDefaultModelForCli('claude'));

    const usage: CapturedUsage = {};
    const { done, abort } = runAgentTurnContainerized(
      {
        projectHostPath: agentHostPath(scratch),
        prompt: framePrompt(frame.prompt, styleSpec, frame.styleName, hasReference),
        oauthToken,
        model,
        systemPrompt: SYSTEM_PROMPT,
        sandboxNet: defaultAgentSandboxNet(),
        containerName: `claudable-design-${frameId}`,
        memory: '1g',
        cpus: '1.0',
        timeoutMs: FRAME_TIMEOUT_MS,
      },
      (evt) => captureUsage(evt as Record<string, unknown>, usage),
    );
    inflight.set(frameId, abort); // so a canvas delete can hard-stop this
    const result = await done;

    const html = await readGeneratedHtml(scratch);
    if (!html) {
      throw new Error(result.error || 'Agent produced no HTML');
    }
    const htmlPath = path.join(scratch, 'index.html');
    await fs.writeFile(htmlPath, html, 'utf8'); // normalize to index.html
    await safeUpdateFrame(frameId, {
      status: 'ready', htmlPath, errorText: null,
      costUsd: usage.costUsd ?? null, inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null, durationMs: usage.durationMs ?? null,
    });
  } catch (error) {
    await safeUpdateFrame(frameId, {
      status: 'error', errorText: error instanceof Error ? error.message.slice(0, 500) : 'Generation failed',
    });
  } finally {
    inflight.delete(frameId);
    releaseSlot();
  }
  await publishFrame(projectId, frameId);
}

/**
 * Generate all `frameIds`. Each frame independently waits for a GLOBAL slot
 * (acquireSlot in generateFrame), so this can safely fire them all at once —
 * the semaphore, not this fan-out, bounds concurrency across every request.
 */
export async function generateFrames(
  projectId: string,
  frameIds: string[],
  requesterUserId?: string,
): Promise<void> {
  if (frameIds.length === 0) return;
  const canvasId = (await prisma.designFrame.findUnique({ where: { id: frameIds[0] }, select: { canvasId: true } }))?.canvasId;

  await Promise.all(frameIds.map((id) => generateFrame(projectId, id, requesterUserId)));

  // Mark the canvas ready once all its frames have settled (independent of the
  // above so one frame's failure can't strand the canvas in `generating`).
  if (canvasId) {
    await prisma.designCanvas.update({ where: { id: canvasId }, data: { status: 'ready' } }).catch(() => {});
  }
}
