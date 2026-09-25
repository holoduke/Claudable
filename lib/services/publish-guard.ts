/**
 * Publish guard for customer projects.
 *
 * A customer's publish goes straight to production (merge → the repo host's CI
 * builds and deploys with deploy credentials). CI configuration, infrastructure
 * code and the container build definition decide WHAT runs with those
 * credentials, so a customer (or their agent) must never change them through a
 * publish: such a publish is refused and New Story changes those files directly
 * in the repository instead.
 */

const PROTECTED_TOP_DIRS = new Set(['.github', '.gitea', '.gitlab', '.circleci', '.buildkite', 'infra', 'terraform']);

const PROTECTED_FILE_NAMES = new Set([
  '.dockerignore',
  '.gitlab-ci.yml',
  '.gitmodules',
  'atlantis.yaml',
  'atlantis.yml',
  'codeowners',
  'renovate.json',
  'renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
]);

/** Whether a repository-relative path is CI / infra / container-build configuration. */
export function isProtectedDeployPath(repoPath: string): boolean {
  const normalized = repoPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  if (PROTECTED_TOP_DIRS.has(segments[0])) return true;
  const name = segments[segments.length - 1];
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return true;
  if (/^(docker-)?compose(\..+)?\.ya?ml$/.test(name)) return true;
  return PROTECTED_FILE_NAMES.has(name);
}

/** The protected paths among a list of changed paths (sorted, de-duplicated). */
export function protectedPathsIn(changedPaths: string[]): string[] {
  return [...new Set(changedPaths.filter(isProtectedDeployPath))].sort();
}
