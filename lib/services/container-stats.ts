/**
 * Live CPU / memory of a project's own containers (frontend preview, backend,
 * managed services) for the Containers panel. One `docker stats --no-stream`
 * over EXACT names — never a prefix filter, so another project's containers are
 * never included.
 */
import { dockerCapture } from '@/lib/services/preview/docker';
import { previewSlug } from '@/lib/services/preview/routes';
import { getServices, serviceContainerName } from '@/lib/services/managed-containers';

export interface ContainerStat {
  cpu: string;     // e.g. "3.21%"
  mem: string;     // e.g. "128.4MiB / 512MiB"
  memPerc: string; // e.g. "25.08%"
}

/** Parse `docker stats --format '{{json .}}'` output into name → stat. */
export function parseStatsLines(out: string): Record<string, ContainerStat> {
  const stats: Record<string, ContainerStat> = {};
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const name = typeof j.Name === 'string' ? j.Name.replace(/^\//u, '') : '';
      if (!name) continue;
      stats[name] = { cpu: String(j.CPUPerc ?? ''), mem: String(j.MemUsage ?? ''), memPerc: String(j.MemPerc ?? '') };
    } catch { /* skip a malformed line */ }
  }
  return stats;
}

/** Stats keyed like the Containers panel rows: 'frontend', 'backend', or a service id. */
export async function projectContainerStats(projectId: string): Promise<Record<string, ContainerStat>> {
  const slug = previewSlug(projectId);
  const byName = new Map<string, string>([
    [`claudable-preview-${slug}`, 'frontend'],
    [`claudable-preview-${slug}-api`, 'backend'],
  ]);
  for (const s of await getServices(projectId).catch(() => [])) byName.set(serviceContainerName(projectId, s.id), s.id);

  // Only running ones: `docker stats` fails the whole call on an unknown name.
  const running = new Set(((await dockerCapture(['ps', '--format', '{{.Names}}'], 10_000)) ?? '').split('\n').map((n) => n.trim()));
  const names = [...byName.keys()].filter((n) => running.has(n));
  if (names.length === 0) return {};
  const out = await dockerCapture(['stats', '--no-stream', '--format', '{{json .}}', ...names], 15_000);
  const parsed = parseStatsLines(out ?? '');
  const result: Record<string, ContainerStat> = {};
  for (const [name, stat] of Object.entries(parsed)) {
    const key = byName.get(name);
    if (key) result[key] = stat;
  }
  return result;
}
