import { describe, expect, it } from 'vitest';
import {
  buildGitHubCloneUrls,
  buildGitCloneArgs,
  parseGitHubRepositoryUrl,
} from '../lib/services/repo-import';
import { redactSensitiveGitText } from '../lib/services/git';

describe('parseGitHubRepositoryUrl', () => {
  it('parses standard GitHub HTTPS URLs', () => {
    expect(parseGitHubRepositoryUrl('https://github.com/opactorai/Claudable')).toEqual({
      owner: 'opactorai',
      repo: 'Claudable',
      branch: null,
    });
  });

  it('parses HTTPS URLs with .git suffix and trailing slash', () => {
    expect(parseGitHubRepositoryUrl('https://github.com/opactorai/Claudable.git/')).toEqual({
      owner: 'opactorai',
      repo: 'Claudable',
      branch: null,
    });
  });

  it('parses SSH shorthand URLs', () => {
    expect(parseGitHubRepositoryUrl('git@github.com:opactorai/Claudable.git')).toEqual({
      owner: 'opactorai',
      repo: 'Claudable',
      branch: null,
    });
  });

  it('extracts branch from GitHub tree URLs', () => {
    expect(parseGitHubRepositoryUrl('https://github.com/opactorai/Claudable/tree/feature/import-repo')).toEqual({
      owner: 'opactorai',
      repo: 'Claudable',
      branch: 'feature/import-repo',
    });
  });

  it('rejects non-GitHub URLs', () => {
    expect(() => parseGitHubRepositoryUrl('https://gitlab.com/opactorai/Claudable')).toThrow(
      'Only github.com repositories are supported',
    );
  });

  it('rejects malformed repository URLs', () => {
    expect(() => parseGitHubRepositoryUrl('https://github.com/opactorai')).toThrow(
      'GitHub repository URL must include owner and repository name',
    );
  });
});

describe('buildGitHubCloneUrls', () => {
  it('returns a clean URL for storage and an authenticated URL for the clone process', () => {
    const urls = buildGitHubCloneUrls({
      owner: 'opactorai',
      repo: 'Claudable',
      token: 'ghp_example-token',
    });

    expect(urls.cleanUrl).toBe('https://github.com/opactorai/Claudable.git');
    expect(urls.authenticatedUrl).toBe('https://x-access-token:ghp_example-token@github.com/opactorai/Claudable.git');
  });

  it('omits authenticated URL when no token is available', () => {
    const urls = buildGitHubCloneUrls({
      owner: 'opactorai',
      repo: 'Claudable',
      token: null,
    });

    expect(urls.cleanUrl).toBe('https://github.com/opactorai/Claudable.git');
    expect(urls.authenticatedUrl).toBeNull();
  });

  it('URL-encodes tokens used for process-only clone URLs', () => {
    const urls = buildGitHubCloneUrls({
      owner: 'opactorai',
      repo: 'Claudable',
      token: 'token/with:reserved@chars',
    });

    expect(urls.authenticatedUrl).toBe(
      'https://x-access-token:token%2Fwith%3Areserved%40chars@github.com/opactorai/Claudable.git',
    );
  });
});

describe('buildGitCloneArgs', () => {
  it('builds clone args without branch selection', () => {
    expect(
      buildGitCloneArgs({
        remoteUrl: 'https://github.com/opactorai/Claudable.git',
        targetPath: '/tmp/claudable-import',
      }),
    ).toEqual(['clone', 'https://github.com/opactorai/Claudable.git', '/tmp/claudable-import']);
  });

  it('builds single-branch clone args when branch is provided', () => {
    expect(
      buildGitCloneArgs({
        remoteUrl: 'https://github.com/opactorai/Claudable.git',
        targetPath: '/tmp/claudable-import',
        branch: 'feature/import-repo',
      }),
    ).toEqual([
      'clone',
      '--branch',
      'feature/import-repo',
      '--single-branch',
      'https://github.com/opactorai/Claudable.git',
      '/tmp/claudable-import',
    ]);
  });
});

describe('redactSensitiveGitText', () => {
  it('redacts GitHub access tokens embedded in clone URLs', () => {
    const text =
      'git clone https://x-access-token:ghp_secret-token@github.com/opactorai/Claudable.git /tmp/import';

    expect(redactSensitiveGitText(text)).toBe(
      'git clone https://x-access-token:[REDACTED]@github.com/opactorai/Claudable.git /tmp/import',
    );
  });

  it('redacts owner-style authenticated GitHub URLs', () => {
    const text =
      'git push https://opactorai:ghp_secret-token@github.com/opactorai/Claudable.git main';

    expect(redactSensitiveGitText(text)).toBe(
      'git push https://opactorai:[REDACTED]@github.com/opactorai/Claudable.git main',
    );
  });
});
