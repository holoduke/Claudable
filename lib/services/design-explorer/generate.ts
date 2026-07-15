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
// A freed slot is handed DIRECTLY to a waiter (the count is never released and
// re-taken), so two microtasks can't both claim the same slot and transiently
// exceed MAX_CONCURRENT.
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (activeSlots < MAX_CONCURRENT && slotWaiters.length === 0) { activeSlots += 1; return; }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
}
function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) { next(); return; } // hand the slot straight to the next waiter
  activeSlots -= 1;
}

// Abort handles for in-flight frames so a canvas delete can hard-stop the
// containers instead of orphaning them (they'd keep burning cost + resources).
// A frame registers a no-op the moment it holds a slot (before the slow setup),
// so a delete arriving during setup marks it cancelled; the real abort replaces
// it once the container spawns.
const inflight = new Map<string, () => void>();
const cancelled = new Set<string>();
/** Hard-stop any still-running generation for these frame ids. */
export function cancelFrames(frameIds: string[]): void {
  for (const id of frameIds) {
    cancelled.add(id);
    const abort = inflight.get(id);
    if (abort) { try { abort(); } catch { /* already gone */ } inflight.delete(id); }
  }
}

/** Purge cancellation markers once the frames are gone (e.g. after the canvas is
 *  deleted) so the `cancelled` Set can't grow unbounded — a cuid is never reused,
 *  and any later generateFrame for a deleted id short-circuits on the missing row. */
export function clearCancelled(frameIds: string[]): void {
  for (const id of frameIds) cancelled.delete(id);
}

/** Boot/periodic recovery: frames left `pending`/`generating` by a crash/restart
 *  have no in-memory worker anymore, so mark the stale ones `error` (the board
 *  polls per-frame status, so this un-sticks their canvases). Guards on age +
 *  `inflight` so it never touches a genuinely-running frame. */
export async function recoverStuckFrames(): Promise<void> {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const rows = await prisma.designFrame
    .findMany({ where: { status: { in: ['pending', 'generating'] }, updatedAt: { lt: cutoff } }, select: { id: true } })
    .catch(() => [] as { id: string }[]);
  for (const r of rows) {
    if (inflight.has(r.id)) continue; // still actually running in this process
    await safeUpdateFrame(r.id, { status: 'error', errorText: 'Generation was interrupted (server restarted).' });
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

/** Friendly stack labels for the project-aware generation context. */
const STACK_LABELS: Record<string, string> = {
  nuxt: 'Nuxt (Vue)', next: 'Next.js (React)', angular: 'Angular', static: 'a static site', laravel: 'Laravel + Filament (Blade)', document: 'a document site',
};

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

function framePrompt(brief: string, styleSpec: string | null, styleName: string | null, hasReference: boolean, projectContext: string | null): string {
  const parts = [`Design brief: ${brief}`, ''];
  if (projectContext) {
    parts.push(projectContext, '');
  }
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
  // CRITICAL: everything after acquireSlot() runs inside the try so the finally
  // ALWAYS releases the slot — even if the 'generating' write or publish throws a
  // transient (non-P2025) DB error. Otherwise a single such error leaks a slot,
  // and MAX_CONCURRENT of them deadlock the whole feature until restart.
  const scratch = frameScratchDir(frame.canvasId, frameId);
  let aborted = false;
  try {
    // Register a placeholder abort IMMEDIATELY (no await before this) so a
    // canvas-delete arriving during the awaited setup still marks this cancelled.
    inflight.set(frameId, () => { aborted = true; });
    if (cancelled.has(frameId)) aborted = true;

    await safeUpdateFrame(frameId, { status: 'generating' });
    await publishFrame(projectId, frameId);

    if (aborted) throw new Error('cancelled');
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

    // Project-aware context (read-only): name/description/stack so the mockup
    // fits the real app and ports cleanly. Generation stays isolated — this only
    // informs the prompt; the agent still can't reach the project's code.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, description: true, templateType: true },
    });
    const projectContext = project
      ? [
          `This mockup is for an existing app called "${project.name}"${project.description ? ` — ${project.description}` : ''}.`,
          project.templateType ? `The app is built with ${STACK_LABELS[project.templateType] || project.templateType}; design so it ports cleanly to that stack (component-based, responsive).` : '',
        ].filter(Boolean).join(' ')
      : null;

    // A cheaper/faster model is plenty for single-file mockups. DESIGN_MODEL
    // (a CLI alias like "sonnet"/"haiku" or a full id) overrides; else the
    // project default. Keeps design exploration inexpensive.
    const model = process.env.DESIGN_MODEL?.trim() || normalizeModelId('claude', getDefaultModelForCli('claude'));

    // Final cancellation check before spending a container on this frame.
    if (aborted || cancelled.has(frameId)) throw new Error('cancelled');

    const usage: CapturedUsage = {};
    const { done, abort } = runAgentTurnContainerized(
      {
        projectHostPath: agentHostPath(scratch),
        prompt: framePrompt(frame.prompt, styleSpec, frame.styleName, hasReference, projectContext),
        oauthToken,
        model,
        systemPrompt: SYSTEM_PROMPT,
        sandboxNet: defaultAgentSandboxNet(),
        containerName: `claudable-design-${frameId}`,
        memory: '1g',
        cpus: '1.0',
        timeoutMs: FRAME_TIMEOUT_MS,
        // Generation only writes one HTML file (and may read the reference image),
        // so restrict the built-in tools to Read/Write. This blocks Bash/WebFetch/
        // Task, so a prompt-injected brief can't exfiltrate the (possibly shared)
        // OAuth token from inside the container.
        allowedTools: 'Read Write',
        // Design generation needs ZERO MCP tools — it only writes one HTML file.
        // Force strict mode so the agent can never inherit the credential owner's
        // account connectors (Gmail/Drive/Calendar/…) when a shared/global token
        // is in use. (No mcpConfigPath is passed, so strict = no MCP at all.)
        strictMcpConfig: true,
      },
      (evt) => captureUsage(evt as Record<string, unknown>, usage),
    );
    inflight.set(frameId, abort); // replace the placeholder with the real hard-stop
    if (cancelled.has(frameId)) { abort(); throw new Error('cancelled'); }
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
    // Never let this reject (the caller's Promise.allSettled + docstring rely on
    // it): record the failure best-effort. A cancelled frame's row may already be
    // gone (P2025, handled) — don't mark it error in that case.
    if (!(aborted || cancelled.has(frameId))) {
      try {
        await safeUpdateFrame(frameId, {
          status: 'error', errorText: error instanceof Error ? error.message.slice(0, 500) : 'Generation failed',
        });
      } catch { /* swallow — nothing more we can do */ }
    }
  } finally {
    inflight.delete(frameId);
    cancelled.delete(frameId);
    releaseSlot();
  }
  try { await publishFrame(projectId, frameId); } catch { /* row may be gone */ }
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

  // allSettled (not all): a single frame rejecting must NOT skip the canvas
  // status reconciliation below (that was a path to a permanently-'generating'
  // canvas). generateFrame is written never to throw, but belt-and-suspenders.
  await Promise.allSettled(frameIds.map((id) => generateFrame(projectId, id, requesterUserId)));

  // Reconcile the canvas status from its ACTUAL frames — only flip to 'ready'
  // when no frame (including ones from a concurrent add-more/combine/refine) is
  // still pending/generating. Avoids a racy premature 'ready' and never strands.
  if (canvasId) {
    try {
      const pending = await prisma.designFrame.count({
        where: { canvasId, status: { in: ['pending', 'generating'] } },
      });
      if (pending === 0) {
        await prisma.designCanvas.update({ where: { id: canvasId }, data: { status: 'ready' } });
      }
    } catch { /* canvas may have been deleted */ }
  }
}
