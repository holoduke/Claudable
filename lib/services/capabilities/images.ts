/**
 * Image-generation CAPABILITY — a project "connects" to it (opt-in), which stores
 * a per-project connection + scoped token (a `ProjectServiceConnection`,
 * provider "images"). The connection can carry its OWN key, or use the shared
 * global key. The MCP tool is only attached to connected projects, and usage is
 * attributable to the connection's token. This is the per-project auth layer that
 * a future network MCP endpoint can reuse unchanged.
 */
import { randomBytes } from 'crypto';
import { encrypt, decrypt } from '@/lib/crypto';
import { getProjectService, upsertProjectServiceConnection } from '@/lib/services/project-services';
import { prisma } from '@/lib/db/client';

const PROVIDER = 'images';

interface ImagesData {
  enabled?: boolean;
  token?: string;
  apiKeyEnc?: string;
  model?: string;
}

async function read(projectId: string): Promise<ImagesData | null> {
  try {
    const svc = await getProjectService(projectId, PROVIDER);
    if (!svc) return null;
    return (svc.serviceData ?? {}) as ImagesData;
  } catch {
    return null;
  }
}

/** Status for the UI: connected?, using its own key vs the shared global key. */
export async function getImagesConnection(projectId: string): Promise<{
  connected: boolean;
  hasOwnKey: boolean;
  usesGlobalKey: boolean;
  globalAvailable: boolean;
}> {
  const data = await read(projectId);
  const connected = !!data && data.enabled !== false;
  const hasOwnKey = !!data?.apiKeyEnc;
  const globalAvailable = !!process.env.XAI_API_KEY;
  return { connected, hasOwnKey, usesGlobalKey: connected && !hasOwnKey && globalAvailable, globalAvailable };
}

/** Connect the project (opt-in). Optionally with its own key; else it uses the shared key. */
export async function connectImages(projectId: string, apiKey?: string): Promise<void> {
  const existing = await read(projectId);
  await upsertProjectServiceConnection(projectId, PROVIDER, {
    enabled: true,
    token: existing?.token || randomBytes(24).toString('hex'),
    ...(apiKey ? { apiKeyEnc: encrypt(apiKey) } : existing?.apiKeyEnc ? { apiKeyEnc: existing.apiKeyEnc } : {}),
  });
}

export async function disconnectImages(projectId: string): Promise<void> {
  await prisma.projectServiceConnection.deleteMany({ where: { projectId, provider: PROVIDER } });
}

/** The API key for this project's image generation, or null if NOT connected
 *  (opt-in gate) or no key is available. Own key wins over the shared global key. */
export async function resolveImagesKey(projectId: string): Promise<string | null> {
  const data = await read(projectId);
  if (!data || data.enabled === false) return null; // not connected → off
  if (data.apiKeyEnc) {
    try { return decrypt(data.apiKeyEnc); } catch { /* fall back to shared */ }
  }
  return process.env.XAI_API_KEY || null;
}

/** Whether image generation is available for this project (connected + a key). */
export async function imagesEnabledFor(projectId: string): Promise<boolean> {
  return !!(await resolveImagesKey(projectId));
}
