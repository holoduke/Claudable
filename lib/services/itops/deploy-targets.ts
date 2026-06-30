/**
 * Deploy targets the it-ops tools know about — the boxes/domains apps can be
 * published to. Sourced at RUNTIME (env or the existing git-provider config) so
 * no infra hostnames are hardcoded in the (public) repo.
 *
 * ITOPS_DEPLOY_TARGETS (JSON array) overrides; otherwise a single target is
 * derived from the configured deploy domain (GIT_DEPLOY_DOMAIN, etc.).
 */
import { getGitProviderConfig } from '@/lib/services/git-provider';

export interface DeployTarget {
  id: string;
  name: string;
  domain: string; // wildcard apex, e.g. example.tf -> apps live at <app>.example.tf
  notes?: string;
}

export function listDeployTargets(): DeployTarget[] {
  const raw = process.env.ITOPS_DEPLOY_TARGETS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as DeployTarget[];
    } catch {
      /* fall through to derived */
    }
  }
  const { deployDomain } = getGitProviderConfig();
  if (!deployDomain) return [];
  return [
    {
      id: 'primary',
      name: 'Primary app host',
      domain: deployDomain,
      notes: 'Coolify/Traefik host with wildcard DNS + Route53 DNS-01 (instance role).',
    },
  ];
}
