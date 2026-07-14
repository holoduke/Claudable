import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

class GitError extends Error {
  constructor(message: string, readonly output?: string) {
    super(message);
    this.name = 'GitError';
  }
}

const DEFAULT_GITIGNORE_ENTRIES = [
  '# Dependencies',
  'node_modules/',
  '',
  '# Next.js build output',
  '.next/',
  'out/',
  '',
  '# Build artifacts',
  'dist/',
  'build/',
  '.turbo/',
  '',
  '# Environment files',
  '.env',
  '.env.*',
  '',
  '# Claudable runtime (may hold a per-turn MCP config with decrypted bearer tokens)',
  '.claudable/agent-mcp.json',
  '',
  '# Misc',
  '.DS_Store',
  '.git-backup-*',
  '.vercel/',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  'pnpm-debug.log*',
];

function ensureGitignore(repoPath: string) {
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${DEFAULT_GITIGNORE_ENTRIES.join('\n')}\n`, 'utf8');
    return;
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const existingLines = existing.split(/\r?\n/);
  const normalized = new Set(existingLines.map((line) => line.trim()));

  const additions = DEFAULT_GITIGNORE_ENTRIES.filter((entry) => {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      // always allow blank lines to keep grouping but avoid duplicating consecutive blanks
      return (
        existingLines.length === 0 ||
        existingLines[existingLines.length - 1].trim().length !== 0
      );
    }
    return !normalized.has(trimmed);
  });

  if (additions.length === 0) {
    return;
  }

  const trimmedExisting = existing.replace(/\s+$/u, '');
  const separator = trimmedExisting.length > 0 ? '\n\n' : '';
  const nextContents = `${trimmedExisting}${separator}${additions.join('\n')}\n`;
  fs.writeFileSync(gitignorePath, nextContents, 'utf8');
}

/**
 * Strip credentials out of any string before it reaches an error message or a
 * log. We authenticate git over HTTPS by embedding `user:token@` in the remote
 * URL, so the token can appear both in the argv we build AND in git's own
 * stderr (which echoes the URL). Without this, a failed fetch/push surfaces the
 * provider token verbatim to the browser via the API error response.
 */
export function redactGitSecrets(s: string): string {
  // https://user:token@host → https://user:***@host
  return s.replace(/(https?:\/\/[^\s:@/]+:)[^\s@/]+@/gu, '$1***@');
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 20, // allow larger git output before hitting ENOBUFS
  });

  if (result.error) {
    throw new GitError(
      redactGitSecrets(`Git command failed: ${result.error.message}`),
      result.stderr || result.stdout ? redactGitSecrets(result.stderr || result.stdout) : undefined,
    );
  }

  if (result.status !== 0) {
    const output =
      (typeof result.stderr === 'string' && result.stderr.trim().length > 0
        ? result.stderr
        : typeof result.stdout === 'string'
        ? result.stdout
        : undefined);
    throw new GitError(
      redactGitSecrets(`Git command failed: git ${args.join(' ')}`),
      output ? redactGitSecrets(output) : undefined,
    );
  }

  return result.stdout.trim();
}

function untrackIgnoredPaths(repoPath: string) {
  const pathsToUntrack = ['node_modules', '.next', 'dist', 'build', 'out', '.turbo', '.vercel'];
  for (const entry of pathsToUntrack) {
    runGit(['rm', '-r', '--cached', '--ignore-unmatch', entry], repoPath);
  }
}

export function ensureGitConfig(repoPath: string, name: string, email: string) {
  runGit(['config', '--local', 'user.name', name], repoPath);
  runGit(['config', '--local', 'user.email', email], repoPath);
}

export function initializeMainBranch(repoPath: string) {
  try {
    runGit(['rev-parse', 'HEAD'], repoPath);
  } catch {
    try {
      runGit(['commit', '--allow-empty', '-m', 'Initial commit'], repoPath);
    } catch (error) {
      throw error;
    }
  }

  try {
    const currentBranch = runGit(['branch', '--show-current'], repoPath);
    if (currentBranch !== 'main') {
      runGit(['branch', '-M', 'main'], repoPath);
    }
  } catch {
    try {
      runGit(['checkout', '-b', 'main'], repoPath);
    } catch {
      // ignore
    }
  }
}

export function addOrUpdateRemote(repoPath: string, remoteName: string, remoteUrl: string) {
  try {
    const existing = runGit(['remote', 'get-url', remoteName], repoPath);
    if (existing !== remoteUrl) {
      runGit(['remote', 'set-url', remoteName, remoteUrl], repoPath);
    }
  } catch {
    runGit(['remote', 'add', remoteName, remoteUrl], repoPath);
  }
}

export function commitAll(repoPath: string, message: string) {
  try {
    untrackIgnoredPaths(repoPath);
    runGit(['add', '-A'], repoPath);
    runGit(['commit', '-m', message], repoPath);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.output && error.output.includes('nothing to commit')) {
      return false;
    }
    throw error;
  }
}

function revParseHead(repoPath: string): string | null {
  try {
    return runGit(['rev-parse', 'HEAD'], repoPath);
  } catch {
    return null;
  }
}

export interface PullResult {
  /** Whether the pull changed the local tree (false = already up to date). */
  updated: boolean;
  before: string | null;
  after: string | null;
  /** Repo-relative paths changed by the merge (empty when not updated). */
  changedFiles: string[];
}

/** Files changed between two commits (name-only). Empty on any failure. */
function diffNames(repoPath: string, from: string | null, to: string | null): string[] {
  if (!from || !to || from === to) return [];
  try {
    const out = runGit(['diff', '--name-only', `${from}..${to}`], repoPath);
    return out.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Fetch `branch` from the remote and merge it into the current checkout.
 * Fast-forwards when possible, otherwise creates a merge commit (local commits
 * are preserved). On a merge conflict the merge is aborted so the working tree
 * is left exactly as before, and an error is thrown for the caller to surface.
 */
export function pullFromRemote(
  repoPath: string,
  remoteName = 'origin',
  branch = 'main',
  remoteUrl?: string,
): PullResult {
  const remote = remoteUrl || remoteName;
  runGit(['fetch', remote, branch], repoPath);
  const before = revParseHead(repoPath);
  try {
    runGit(['merge', '--ff-only', 'FETCH_HEAD'], repoPath);
  } catch {
    try {
      runGit(['merge', '--no-edit', '-m', `Sync with remote ${branch}`, 'FETCH_HEAD'], repoPath);
    } catch (error) {
      try {
        runGit(['merge', '--abort'], repoPath);
      } catch {
        /* no merge in progress */
      }
      const detail = error instanceof GitError ? error.output ?? '' : '';
      // Only a genuine content conflict warrants the "both changed the same
      // files" guidance; unrelated-histories / untracked-overwrite / other
      // failures get their real cause instead of misleading advice.
      const isConflict = /conflict|would be overwritten/iu.test(detail);
      const message = isConflict
        ? `Merge conflict while syncing branch '${branch}' — the local project and the remote branch both changed the same files. Resolve the divergence (or reset local changes) before syncing.`
        : `Could not sync branch '${branch}': ${detail.trim() || 'git merge failed'}`;
      throw new GitError(message, detail || undefined);
    }
  }
  const after = revParseHead(repoPath);
  const updated = before !== after;
  return { updated, before, after, changedFiles: updated ? diffNames(repoPath, before, after) : [] };
}

export function pushToRemote(
  repoPath: string,
  remoteName = 'origin',
  branch = 'main',
  remoteUrl?: string,
) {
  const remote = remoteUrl || remoteName;
  // Push the current HEAD to the target branch regardless of the local branch
  // name (a freshly `git init`-ed repo is on `master`, but we deploy from
  // `main`). `HEAD:main` maps whatever is checked out to the remote branch.
  const refspec = `HEAD:${branch}`;
  try {
    runGit(['push', '-u', remote, refspec], repoPath);
  } catch (error) {
    if (!(error instanceof GitError)) {
      throw error;
    }
    // Retry with --force-with-lease, NOT a blanket --force. A plain non-ff
    // reject (our local history rewrote the connect scaffold) still succeeds,
    // but if the remote branch moved because a teammate pushed, the lease
    // fails and we surface a clear error instead of silently clobbering their
    // commits — which the Sync feature makes a routine divergence. The user
    // must Sync first, then push.
    try {
      runGit(['push', '-u', '--force-with-lease', remote, refspec], repoPath);
    } catch (leaseError) {
      if (leaseError instanceof GitError) {
        throw new GitError(
          `Push rejected: the remote branch '${branch}' has commits your project doesn't have yet. Sync first, then push. (Refusing to force-overwrite remote history.)`,
          leaseError.output,
        );
      }
      throw leaseError;
    }
  }
}

/**
 * Point the local checkout at `branch` from the remote after the operating
 * branch is changed. Without this, the checkout keeps the OLD branch's history,
 * so the next sync/push weaves or force-rejects the wrong content across
 * branches. Best-effort and non-destructive: it only realigns when the tree is
 * clean AND the remote branch exists; a dirty tree or a brand-new branch is
 * left as-is (the next Sync reconciles). Returns whether it realigned.
 */
export function checkoutRemoteBranch(
  repoPath: string,
  branch: string,
  remoteUrl: string,
): boolean {
  // Refuse on a dirty tree — never silently discard the user's uncommitted work.
  const dirty = runGit(['status', '--porcelain'], repoPath);
  if (dirty.trim().length > 0) return false;
  try {
    runGit(['fetch', remoteUrl, branch], repoPath);
  } catch {
    return false; // branch doesn't exist on the remote yet
  }
  runGit(['checkout', '-B', branch, 'FETCH_HEAD'], repoPath);
  return true;
}

export function ensureGitRepository(repoPath: string) {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    runGit(['init'], repoPath);
  }
  ensureGitignore(repoPath);
}
