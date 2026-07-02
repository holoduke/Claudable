/**
 * In-process MCP server that lets the agent GENERATE IMAGES for the app it's
 * building. Uses xAI (Grok) image generation. The API key stays in Claudable
 * (never in the agent's scrubbed env) — read from the project's `XAI_API_KEY`
 * Env var, or a global `XAI_API_KEY`. Generated images are saved into the
 * project's `public/generated/` so they're served at `/generated/<file>`.
 *
 * Bound to a single project (executeClaude spawns one per turn).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { listEnvVars } from './env';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const XAI_IMAGE_URL = 'https://api.x.ai/v1/images/generations';
const XAI_IMAGE_MODEL = 'grok-2-image';

/** Resolve the image API key: the project's own Env var wins, else the global one. */
async function resolveKey(projectId: string): Promise<string | null> {
  try {
    for (const ev of await listEnvVars(projectId)) {
      if ((ev.key === 'XAI_API_KEY' || ev.key === 'IMAGE_API_KEY') && ev.value) return ev.value;
    }
  } catch { /* fall through to global */ }
  return process.env.XAI_API_KEY || null;
}

/** Whether image generation is available for this project (a key exists). */
export async function imagesEnabledFor(projectId: string): Promise<boolean> {
  return !!(await resolveKey(projectId));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'image';
}

export function buildImagesMcpServer(projectId: string, projectPath: string) {
  return createSdkMcpServer({
    name: 'images',
    version: '0.1.0',
    tools: [
      tool(
        'generate_image',
        'Generate an image from a text prompt (xAI / Grok) and save it into this project so it can be used in the app. Returns the public path (e.g. /generated/hero.png) — reference that path in an <img>/background/asset. Use this whenever the app needs a real image (hero, illustration, avatar, texture) instead of a placeholder.',
        {
          prompt: z.string().min(1).describe('A detailed description of the image to generate.'),
          name: z.string().optional().describe('Optional file name (no extension) — a slug is derived from the prompt otherwise.'),
          count: z.number().int().min(1).max(4).optional().describe('How many images to generate (default 1).'),
        },
        async (args) => {
          const key = await resolveKey(projectId);
          if (!key) {
            return text('Image generation is not configured for this project. Set an `XAI_API_KEY` in the project Env vars (Settings → Envs), then try again.');
          }
          const n = args.count ?? 1;
          let resp: Response;
          try {
            resp = await fetch(XAI_IMAGE_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
              body: JSON.stringify({ model: XAI_IMAGE_MODEL, prompt: args.prompt, n, response_format: 'b64_json' }),
            });
          } catch (e) {
            return text(`Image request failed (network): ${(e as Error).message}`);
          }
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            return text(`Image generation failed (HTTP ${resp.status}). ${body.slice(0, 300)}`);
          }
          const json = (await resp.json().catch(() => null)) as { data?: Array<{ b64_json?: string; url?: string }> } | null;
          const items = json?.data ?? [];
          if (!items.length) return text('The image API returned no images.');

          const outDir = path.join(projectPath, 'public', 'generated');
          await fs.mkdir(outDir, { recursive: true });
          const base = slugify(args.name || args.prompt);
          const stamp = Date.now().toString(36);
          const saved: string[] = [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            let bytes: Buffer | null = null;
            if (it.b64_json) bytes = Buffer.from(it.b64_json, 'base64');
            else if (it.url) {
              try { bytes = Buffer.from(await (await fetch(it.url)).arrayBuffer()); } catch { /* skip */ }
            }
            if (!bytes) continue;
            const file = `${base}-${stamp}${items.length > 1 ? `-${i + 1}` : ''}.png`;
            await fs.writeFile(path.join(outDir, file), bytes);
            saved.push(`/generated/${file}`);
          }
          if (!saved.length) return text('Could not save the generated image(s).');
          return text(
            `Generated ${saved.length} image(s), saved to the project's public/generated/ and served at:\n` +
            saved.map((p) => `- ${p}`).join('\n') +
            `\n\nUse these paths directly in the app (e.g. <img src="${saved[0]}">).`,
          );
        },
      ),
    ],
  });
}
