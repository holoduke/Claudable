import { describe, expect, it } from 'vitest';
import { isProtectedDeployPath, protectedPathsIn } from './publish-guard';

describe('publish guard', () => {
  it.each([
    '.github/workflows/deployment.yml',
    '.gitea/workflows/deploy.yml',
    'infra/prod/main.tf',
    'infra/prod/env.secrets.json',
    'Dockerfile',
    'docker/Dockerfile.backend',
    'build/app.dockerfile',
    'docker-compose.yml',
    'docker-compose.prod.yaml',
    'compose.yml',
    '.dockerignore',
    'atlantis.yaml',
    'renovate.json',
    '.github/CODEOWNERS',
    'CODEOWNERS',
    '.gitmodules',
  ])('protects %s', (p) => {
    expect(isProtectedDeployPath(p)).toBe(true);
  });

  it.each([
    'app/pages/index.vue',
    'server/plugins/03.security-headers.ts',
    'package.json',
    'public/images/infra-diagram.png',
    'content/github-guide.md',
    'components/DockerfileExplainer.vue',
  ])('allows %s', (p) => {
    expect(isProtectedDeployPath(p)).toBe(false);
  });

  it('reports the protected paths among a change set', () => {
    expect(protectedPathsIn(['app.vue', 'Dockerfile', '.github/x.yml', 'Dockerfile'])).toEqual(['.github/x.yml', 'Dockerfile']);
  });
});
