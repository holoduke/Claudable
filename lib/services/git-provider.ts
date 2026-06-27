/**
 * Git provider configuration.
 *
 * Claudable was originally GitHub-only. This module makes the repo-management
 * layer provider-aware so it can target a self-hosted Gitea instance (or any
 * GitHub-compatible API) via environment variables, without changing the rest
 * of the app. The plain-git push layer (`git.ts`) is already provider-agnostic.
 *
 * Env vars (all optional; defaults keep GitHub behaviour):
 *   GIT_PROVIDER      'github' | 'gitea'                (default 'github')
 *   GIT_API_BASE_URL  REST API base                     (e.g. https://git.example.com/api/v1)
 *   GIT_HTTP_BASE     Web/clone base used for auth URLs  (e.g. https://git.example.com)
 *   GIT_ORG           Create repos under this org        (else under the user account)
 *   GIT_TOKEN         API token fallback                 (else the DB-stored 'github' token is used)
 *   GIT_DEPLOY_DOMAIN Base domain for live deploys       (e.g. example.com -> <site>.example.com)
 */

export type GitProvider = 'github' | 'gitea';

export interface GitProviderConfig {
  provider: GitProvider;
  apiBaseUrl: string;
  httpBase: string;
  org: string | null;
  deployDomain: string | null;
  /** Authorization header scheme for API calls. */
  authScheme: 'Bearer' | 'token';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function getGitProviderConfig(): GitProviderConfig {
  const provider = (process.env.GIT_PROVIDER === 'gitea' ? 'gitea' : 'github') as GitProvider;

  const apiBaseUrl = trimTrailingSlash(
    process.env.GIT_API_BASE_URL ||
      (provider === 'gitea' ? 'https://git.example.com/api/v1' : 'https://api.github.com'),
  );

  const httpBase = trimTrailingSlash(
    process.env.GIT_HTTP_BASE ||
      (provider === 'gitea' ? apiBaseUrl.replace(/\/api\/v1$/u, '') : 'https://github.com'),
  );

  const org = process.env.GIT_ORG && process.env.GIT_ORG.trim().length > 0 ? process.env.GIT_ORG.trim() : null;
  const deployDomain =
    process.env.GIT_DEPLOY_DOMAIN && process.env.GIT_DEPLOY_DOMAIN.trim().length > 0
      ? process.env.GIT_DEPLOY_DOMAIN.trim()
      : null;

  // Gitea accepts both "token <t>" and "Bearer <t>"; GitHub wants Bearer.
  const authScheme: 'Bearer' | 'token' = provider === 'gitea' ? 'token' : 'Bearer';

  return { provider, apiBaseUrl, httpBase, org, deployDomain, authScheme };
}

/** Env-provided token takes precedence so the server can run unattended. */
export function getEnvGitToken(): string | null {
  const token = process.env.GIT_TOKEN;
  return token && token.trim().length > 0 ? token.trim() : null;
}
