/**
 * Global system overview — every container + network on the host, mapped to the
 * project that owns it. Read-only (admin-gated at the route). Reads the Docker
 * state via the socket-proxy (the same DOCKER_HOST Claudable already uses).
 * Part of the target-architecture "system overview" requirement (#6).
 */
import { spawn } from 'child_process';

export interface SystemContainer {
  name: string;
  image: string;
  status: string;
  state: string;        // running / exited / ...
  ports: string;
  networks: string;
  project: string;      // owning project id, or a role (system / manual / '-')
  role: 'frontend' | 'backend' | 'database' | 'system' | 'other';
}
export interface SystemNetwork {
  name: string;
  driver: string;
  subnet: string;
  icc: string;          // 'on' | 'off' | ''
}
export interface SystemOverview {
  host: string;
  containers: SystemContainer[];
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

/** Classify a container name into (project, role). */
function classify(name: string): { project: string; role: SystemContainer['role'] } {
  if (name === 'claudable' || name === 'claudable-dockerproxy') return { project: 'system', role: 'system' };
  const preview = name.match(/^claudable-preview-(.+?)(-api)?$/u);
  if (preview) return { project: preview[1], role: preview[2] ? 'backend' : 'frontend' };
  if (/-(db|postgres|mysql)$/u.test(name)) return { project: name.replace(/-(db|postgres|mysql)$/u, ''), role: 'database' };
  if (/-api$/u.test(name)) return { project: name.replace(/-api$/u, ''), role: 'backend' };
  return { project: '-', role: 'other' };
}

export async function getSystemOverview(): Promise<SystemOverview> {
  const [rawC, rawN] = await Promise.all([
    docker(['ps', '-a', '--format', '{{json .}}']),
    docker(['network', 'ls', '--format', '{{json .}}']),
  ]);

  const containers: SystemContainer[] = [];
  for (const line of rawC.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const c = JSON.parse(t) as Record<string, string>;
      const name = c.Names || c.Name || '';
      const { project, role } = classify(name);
      containers.push({
        name,
        image: c.Image || '',
        status: c.Status || '',
        state: (c.State || '').toLowerCase(),
        ports: c.Ports || '',
        networks: c.Networks || '',
        project,
        role,
      });
    } catch { /* skip malformed line */ }
  }
  containers.sort((a, b) => (a.project + a.role).localeCompare(b.project + b.role));

  // Networks: list, then inspect the claudable-relevant ones for subnet + icc.
  const netNames: string[] = [];
  for (const line of rawN.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const n = JSON.parse(t) as Record<string, string>;
      if (n.Name) netNames.push(n.Name);
    } catch { /* skip */ }
  }
  const networks: SystemNetwork[] = [];
  await Promise.all(netNames.map(async (name) => {
    const raw = await docker(['network', 'inspect', name, '--format',
      '{{.Driver}}|{{range .IPAM.Config}}{{.Subnet}}{{end}}|{{index .Options "com.docker.network.bridge.enable_icc"}}']);
    const [driver = '', subnet = '', icc = ''] = raw.trim().split('|');
    networks.push({ name, driver, subnet, icc: icc === 'false' ? 'off' : icc === 'true' ? 'on' : '' });
  }));
  networks.sort((a, b) => a.name.localeCompare(b.name));

  return {
    host: process.env.DEPLOY_HOST || process.env.HOSTNAME || 'box1',
    containers,
    networks,
    generatedAt: Date.now(),
  };
}
