import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const getProjectById = vi.fn(async () => null);
vi.mock('@/lib/services/project', () => ({ getProjectById, updateProject: vi.fn() }));

const { pushProjectToGitHub, GitHubError, PUBLISH_WHILE_AGENT_BUSY_MESSAGE } = await import('./github');
const { tryReserveAgentRun, releaseAgentRun } = await import('./cli/run-registry');

describe('pushProjectToGitHub — agent turn gate', () => {
  afterEach(() => {
    releaseAgentRun('busy-project');
    getProjectById.mockClear();
  });

  it('refuses with 409 while an agent turn holds the project slot, before touching git', async () => {
    expect(tryReserveAgentRun('busy-project')).toBe(true);
    const err = await pushProjectToGitHub('busy-project').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as InstanceType<typeof GitHubError>).status).toBe(409);
    expect((err as Error).message).toBe(PUBLISH_WHILE_AGENT_BUSY_MESSAGE);
    expect(getProjectById).not.toHaveBeenCalled();
  });

  it('proceeds to the push when no turn is running', async () => {
    const err = await pushProjectToGitHub('busy-project').catch((e: unknown) => e);
    // Reaches the implementation (which fails on the stubbed missing project).
    expect(getProjectById).toHaveBeenCalledWith('busy-project');
    expect((err as Error).message).not.toBe(PUBLISH_WHILE_AGENT_BUSY_MESSAGE);
  });
});
