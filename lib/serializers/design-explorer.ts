/**
 * Client serializers for the Design Explorer. Dates → ISO strings, nullish
 * normalized, and the on-disk `htmlPath` is deliberately NOT exposed — the
 * mockup HTML is fetched separately via the frame html endpoint so list/canvas
 * payloads stay light (same discipline as omitting `initialPrompt` from lists).
 */
import type { DesignCanvas, DesignFrame } from '@prisma/client';

export interface SerializedDesignFrame {
  id: string;
  canvasId: string;
  styleId: string | null;
  styleName: string | null;
  prompt: string;
  status: string; // pending | generating | ready | error
  errorText: string | null;
  version: number;
  parentFrameId: string | null;
  /** True when a rendered mockup exists (fetch it from the html endpoint). */
  hasHtml: boolean;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedDesignCanvas {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  status: string; // idle | generating | ready
  createdById: string | null;
  hasReference: boolean;
  createdAt: string;
  updatedAt: string;
  frames: SerializedDesignFrame[];
}

export function serializeDesignFrame(frame: DesignFrame): SerializedDesignFrame {
  return {
    id: frame.id,
    canvasId: frame.canvasId,
    styleId: frame.styleId ?? null,
    styleName: frame.styleName ?? null,
    prompt: frame.prompt,
    status: frame.status,
    errorText: frame.errorText ?? null,
    version: frame.version,
    parentFrameId: frame.parentFrameId ?? null,
    hasHtml: Boolean(frame.htmlPath) && frame.status === 'ready',
    costUsd: frame.costUsd ?? null,
    durationMs: frame.durationMs ?? null,
    createdAt: frame.createdAt.toISOString(),
    updatedAt: frame.updatedAt.toISOString(),
  };
}

export function serializeDesignCanvas(
  canvas: DesignCanvas & { frames?: DesignFrame[] },
): SerializedDesignCanvas {
  return {
    id: canvas.id,
    projectId: canvas.projectId,
    title: canvas.title,
    prompt: canvas.prompt,
    status: canvas.status,
    createdById: canvas.createdById ?? null,
    hasReference: Boolean(canvas.referenceImagePath),
    createdAt: canvas.createdAt.toISOString(),
    updatedAt: canvas.updatedAt.toISOString(),
    frames: (canvas.frames ?? []).map(serializeDesignFrame),
  };
}
