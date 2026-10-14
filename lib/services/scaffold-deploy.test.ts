import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/git-provider', () => ({
  getGitProviderConfig: () => ({ deployDomain: 'newstory.tf', httpBase: 'https://git.example', org: 'newstory-org' }),
}));
vi.mock('@/lib/services/deploy-port', async (importOriginal) => {
  const real = await importOriginal<typeof import('./deploy-port')>();
  // No real host probing in tests: only the route files count.
  return { ...real, resolveDeployPort: (site: string, current: number | null) => real.resolveDeployPort(site, current, { isListening: async () => false }) };
});

import { forwardableSecrets, injectDeployScaffolding } from './scaffold-deploy';

let repo: string;
let routes: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-'));
  routes = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-'));
  process.env.TRAEFIK_DYNAMIC_DIR = routes;
});

afterEach(async () => {
  delete process.env.TRAEFIK_DYNAMIC_DIR;
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(routes, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFile(path.join(repo, rel), 'utf8');

/** The `run: |` body of the workflow, de-indented, so bash can syntax-check it. */
function runScript(workflow: string): string {
  const body = workflow.split('run: |\n')[1];
  return body.split('\n').map((line) => line.replace(/^ {10}/u, '')).join('\n');
}

describe('forwardableSecrets', () => {
  it('drops deploy credentials, runner names and unsafe names', () => {
    expect(forwardableSecrets(['NUXT_B', 'DEPLOY_TOKEN', 'COOLIFY_TOKEN', 'GITEA_X', 'DATABASE_URL', 'bad-name', 'NUXT_A', 'NUXT_A']))
      .toEqual(['NUXT_A', 'NUXT_B']);
  });
});

describe('injectDeployScaffolding', () => {
  it('moves a compose port that another site already routes to, and routes the new port', async () => {
    await fs.writeFile(path.join(routes, 'newstory.yml'), 'url: "http://10.0.1.1:3561"\n');
    await fs.writeFile(path.join(repo, 'docker-compose.yml'), 'services:\n  app:\n    environment:\n      - PORT=3561\n      - NITRO_PORT=3561\n');

    await injectDeployScaffolding(repo, { repoName: 'Incidentmanagement' });

    const compose = await read('docker-compose.yml');
    const workflow = await read('.gitea/workflows/deploy.yml');
    const port = Number(/PORT=(\d+)/u.exec(compose)?.[1]);
    expect(port).not.toBe(3561);
    expect(compose).toContain(`NITRO_PORT=${port}`);
    expect(workflow).toContain(`PORT=${port}\n`);
  });

  it('keeps a free compose port as is', async () => {
    await fs.writeFile(path.join(repo, 'docker-compose.yml'), 'services:\n  app:\n    environment:\n      - PORT=3762\n');
    await injectDeployScaffolding(repo, { repoName: 'incidentmanagement' });
    expect(await read('.gitea/workflows/deploy.yml')).toContain('PORT=3762\n');
  });

  it('writes the repo secrets into the runtime .env and checks who owns the port', async () => {
    await injectDeployScaffolding(repo, { repoName: 'incidentmanagement', runtimeSecrets: ['NUXT_GOOGLE_CLIENT_ID', 'DEPLOY_TOKEN'] });
    const workflow = await read('.gitea/workflows/deploy.yml');
    expect(workflow).toContain('RT_NUXT_GOOGLE_CLIENT_ID: ${{ secrets.NUXT_GOOGLE_CLIENT_ID }}');
    expect(workflow).not.toContain('RT_DEPLOY_TOKEN');
    expect(workflow).toContain('for NAME in NUXT_GOOGLE_CLIENT_ID; do');
    expect(workflow).toContain('/proc/$PID/cgroup');
    execFileSync('bash', ['-n'], { input: runScript(workflow) });
  });

  it('adds no secret step when the repo has none', async () => {
    await injectDeployScaffolding(repo, { repoName: 'plain' });
    const workflow = await read('.gitea/workflows/deploy.yml');
    expect(workflow).not.toContain('for NAME in');
    execFileSync('bash', ['-n'], { input: runScript(workflow) });
  });
});
