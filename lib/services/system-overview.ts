/**
 * Global system / NETWORK overview — every container + network on the host,
 * joined to the Claudable project that owns it, with each project's addresses
 * and public access links. Read-only (admin-gated at the route). Reads Docker
 * state via the socket-proxy (the same DOCKER_HOST Claudable already uses) and
 * the project list from the DB. Target-architecture requirement #6 (+ #2/#3:
 * first-class project↔container mapping shown in the UI).
 */
import { spawn } from 'child_process';
import { getAllProjects } from './project';
import { getProjectService } from './project-services';
import { previewSlug, projectPreviewUrl } from './preview';

export interface SystemContainer {
  name: string;
  image: string;
  status: string;
  state: string;        // running / exited / ...
  ports: string;
  networks: string;
  project: string;      // owning project id, or a role (system / manual / '-')
  role: 'frontend' | 'backend' | 'database' | 'agent' | 'system' | 'other';
}
export interface SystemNetwork {
  name: string;
  driver: string;
  subnet: string;
  icc: string;          // 'on' | 'off' | ''
}
export interface ProjectOverview {
  id: string;
  name: string;
  stack: string;                 // templateType (nuxt/next/angular/static/…)
  previewUrl: string | null;     // public access link (preview-<slug>.<domain>)
  running: boolean;              // any owned container is up
  hasDatabase: boolean;
  agentContainerized: boolean;   // agent turns run in an isolated container
  internalNetwork: string | null; // per-project internal net (claudable-proj-<slug>)
  containers: SystemContainer[];
}
export interface SystemOverview {
  host: string;
  agentContainerized: boolean;   // global default for agent-turn isolation
  previewIsolation: boolean;     // whether preview containers are enabled
  projects: ProjectOverview[];
  unassigned: SystemContainer[]; // containers not owned by a known project (manual/system)
  networks: SystemNetwork[];
  generatedAt: number;
}

/** Run a docker CLI command via the proxy and return stdout (empty on failure). */
function docker(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('docker', args, { env: process.env });
    p.stdout?.on('data', (c) => { out += c.toString(); });
    p.on('error', () => resolve(''));
    p.on('exit', () => resolve(out));
  });
}

/** Whether the agent runs containerized — mirrors the gate in cli/claude.ts. */
function agentContainerizedDefault(): boolean {
  const flag = process.env.AGENT_CONTAINERIZED?.trim();
  return flag ? flag === 'true' : Boolean(process.env.PREVIEW_ISOLATION?.trim());
}

/** Role of a container from its name, given the set of known project slugs. */
function roleOf(name: string): SystemContainer['role'] {
  if (name === 'claudable' || name === 'claudable-dockerproxy') return 'system';
  if (/^claudable-agent-/u.test(name)) return 'agent';
  if (/^claudable-preview-.+-api$/u.test(name)) return 'backend';
  if (/^claudable-preview-/u.test(name)) return 'frontend';
  if (/-(db|postgres|mysql)$/u.test(name)) return 'database';
  if (/-api$/u.test(name)) return 'backend';
  return 'other';
}

export async function getSystemOverview(): Promise<SystemOverview> {
  const [rawC, rawN, projects] = await Promise.all([
    docker(['ps', '-a', '--format', '{{json .}}']),
    docker(['network', 'ls', '--format', '{{json .}}']),
    getAllProjects().catch(() => []),
  ]);

  // Parse all containers first (role known; project resolved below by slug match).
  const parsed: SystemContainer[] = [];
  for (const line of rawC.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const c = JSON.parse(t) as Record<string, string>;
      const name = c.Names || c.Name || '';
      if (!name) continue;
      parsed.push({
        name,
        image: c.Image || '',
        status: c.Status || '',
        state: (c.State || '').toLowerCase(),
        ports: c.Ports || '',
        networks: c.Networks || '',
        project: '-',
        role: roleOf(name),
      });
    } catch { /* skip malformed line */ }
  }

  // Match containers to projects by SLUG (container names use previewSlug(id),
  // which differs from the raw id for long/sanitized ids). Longest slug first so
  // a project whose slug is a prefix of another can't steal its containers.
  const slugMap = projects
    .map((p) => ({ id: p.id, slug: previewSlug(p.id) }))
    .sort((a, b) => b.slug.length - a.slug.length);

  const ownerOf = (name: string): string | null => {
    for (const { id, slug } of slugMap) {
      if (name.includes(slug)) return id;
    }
    return null;
  };

  const byProject = new Map<string, SystemContainer[]>();
  const unassigned: SystemContainer[] = [];
  for (const c of parsed) {
    if (c.role === 'system') { unassigned.push(c); continue; }
    const owner = ownerOf(c.name);
    if (owner) {
      c.project = owner;
      (byProject.get(owner) ?? byProject.set(owner, []).get(owner)!).push(c);
    } else {
      unassigned.push(c);
    }
  }

  const agentContainerized = agentContainerizedDefault();
  const knownNets = new Set(
    rawN.split('\n').map((l) => { try { return (JSON.parse(l) as { Name?: string }).Name; } catch { return undefined; } }).filter(Boolean) as string[],
  );

  // Build per-project overview rows.
  const projectRows: ProjectOverview[] = await Promise.all(projects.map(async (p) => {
    const containers = (byProject.get(p.id) ?? []).sort((a, b) => a.role.localeCompare(b.role));
    let hasDatabase = containers.some((c) => c.role === 'database');
    if (!hasDatabase) {
      try {
        const dbSvc = await getProjectService(p.id, 'database');
        hasDatabase = Boolean((dbSvc?.serviceData as { engine?: string } | undefined)?.engine);
      } catch { /* non-fatal */ }
    }
    const projNet = `claudable-proj-${previewSlug(p.id)}`;
    return {
      id: p.id,
      name: p.name || p.id,
      stack: (p as { templateType?: string }).templateType || '',
      previewUrl: projectPreviewUrl(p.id),
      running: containers.some((c) => c.state.includes('run') || c.state.includes('up')),
      hasDatabase,
      agentContainerized,
      internalNetwork: knownNets.has(projNet) ? projNet : null,
      containers,
    };
  }));
  projectRows.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));

  // Networks: inspect for subnet + icc.
  const networks: SystemNetwork[] = [];
  await Promise.all([...knownNets].map(async (name) => {
    const raw = await docker(['network', 'inspect', name, '--format',
      '{{.Driver}}|{{range .IPAM.Config}}{{.Subnet}}{{end}}|{{index .Options "com.docker.network.bridge.enable_icc"}}']);
    const [driver = '', subnet = '', icc = ''] = raw.trim().split('|');
    networks.push({ name, driver, subnet, icc: icc === 'false' ? 'off' : icc === 'true' ? 'on' : '' });
  }));
  networks.sort((a, b) => a.name.localeCompare(b.name));

  unassigned.sort((a, b) => a.name.localeCompare(b.name));

  return {
    host: process.env.DEPLOY_HOST || process.env.HOSTNAME || 'box1',
    agentContainerized,
    previewIsolation: Boolean(process.env.PREVIEW_ISOLATION?.trim()),
    projects: projectRows,
    unassigned,
    networks,
    generatedAt: Date.now(),
  };
}
