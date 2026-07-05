/**
 * Service Integration Helper
 * Common utilities for integrating external services (GitHub, Vercel, etc.)
 * This module breaks circular dependencies between service modules
 */

import { getProjectService } from '@/lib/services/project-services';

/**
 * Get GitHub repository information from project services
 */
export async function getProjectGitHubRepo(projectId: string): Promise<{
  owner: string;
  repoName: string;
  fullName: string;
} | null> {
  const githubService = await getProjectService(projectId, 'github');
  const githubData = githubService?.serviceData as Record<string, unknown> | undefined;

  if (githubData && typeof githubData.owner === 'string' && typeof githubData.repo_name === 'string') {
    return {
      owner: githubData.owner,
      repoName: githubData.repo_name,
      fullName: `${githubData.owner}/${githubData.repo_name}`,
    };
  }

  return null;
}
