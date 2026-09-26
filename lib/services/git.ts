import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { readTextInsideSync, writeFileInsideSync } from '@/lib/utils/safe-fs';

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

  // Symlink-safe: .gitignore is project (agent) content.
  const existing = readTextInsideSync(repoPath, gitignorePath);
  if (!existing) {
    writeFileInsideSync(repoPath, gitignorePath, `${DEFAULT_GITIGNORE_ENTRIES.join('\n')}\n`);
    return;
  }

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
  writeFileInsideSync(repoPath, gitignorePath, nextContents);
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

/*
 * SECURITY: a project's .git lives inside the directory the agent (and the
 * project's preview) can write, but git runs HERE, in the Claudable process with
 * its tokens. Hooks, `core.fsmonitor`, filter/diff drivers, `include.path`,
 * `url.*.insteadOf`, a `.git` file pointing at another repository or object
 * alternates would all let project-controlled content run commands or redirect a
 * push (with its token) from the control plane. So every git call runs with those
 * features forced off, a minimal env, and only on a repository whose config holds
 * nothing but plain, known-safe keys.
 */
export const HARDENED_GIT_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'core.editor=true',
  '-c', 'core.sshCommand=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.file.allow=never',
  '-c', 'credential.helper=',
];

const SAFE_GIT_CONFIG_KEY =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol)|remote\..+\.(url|fetch)|branch\..+\.(remote|merge|rebase)|user\.(name|email)|init\.defaultbranch|pull\.(rebase|ff)|extensions\.objectformat|gc\.auto|index\.version)$/i;

export function gitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ',
    // TLS trust + outbound proxy, so HTTPS remotes keep working where configured.
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'no_proxy',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env as NodeJS.ProcessEnv;
}

/** Refuse to run git on a repository whose .git could run code or redirect git. */
export function assertSafeGitRepository(repoPath: string): void {
  const gitPath = path.join(repoPath, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(gitPath);
  } catch {
    return; // no repository yet (git init / clone creates one)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GitError('Refusing to run git: .git is not a plain directory (symlink or gitdir file).');
  }
  for (const redirect of ['commondir', path.join('objects', 'info', 'alternates')]) {
    if (fs.existsSync(path.join(gitPath, redirect))) {
      throw new GitError(`Refusing to run git: .git/${redirect} points git at another repository.`);
    }
  }
  const configFile = path.join(gitPath, 'config');
  if (!fs.existsSync(configFile)) return;
  const listed = spawnSync('git', ['config', '--no-includes', '--file', configFile, '--list', '--name-only'], {
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (listed.status !== 0) {
    throw new GitError('Refusing to run git: the repository config could not be read.', listed.stderr || undefined);
  }
  const unsafe = listed.stdout.split(/\r?\n/u).map((k) => k.trim()).filter((k) => k && !SAFE_GIT_CONFIG_KEY.test(k));
  if (unsafe.length > 0) {
    throw new GitError(`Refusing to run git: unsafe setting(s) in .git/config: ${[...new Set(unsafe)].join(', ')}`);
  }
}

function runGit(args: string[], cwd: string): string {
  assertSafeGitRepository(cwd);
  const result = spawnSync('git', [...HARDENED_GIT_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
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

/** Current HEAD commit sha, or null when the path is not a repo / has no commits. */
export function getHeadCommit(repoPath: string): string | null {
  return revParseHead(repoPath);
}

// The sha flows into git argv; only accept plain hex so it can never be an option.
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/iu;

/**
 * How many files the working tree has changed but not committed — the usual
 * shape of "not published yet", since an agent turn edits files and only the
 * publish itself commits them. Ignored paths (node_modules, build output) are
 * excluded by .gitignore. Returns 0 on any failure rather than guessing.
 */
export function countDirtyFiles(repoPath: string): number {
  try {
    const out = runGit(['status', '--porcelain'], repoPath);
    return out.split(/\r?\n/u).filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Commits in the local checkout that `baseSha` doesn't have — i.e. committed
 * work the remote (and therefore the published site) is missing. Null when the
 * base commit isn't known locally, so the caller can say "unknown" instead of
 * reporting a wrong number.
 */
export function countCommitsAhead(repoPath: string, baseSha: string): number | null {
  if (!COMMIT_SHA_RE.test(baseSha)) return null;
  try {
    runGit(['cat-file', '-e', `${baseSha}^{commit}`], repoPath);
    const out = runGit(['rev-list', '--count', `${baseSha}..HEAD`], repoPath);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Whether `sha` is present locally AND reachable from HEAD. False means the
 * commit is unknown here (never fetched) or on a diverged line — either way,
 * the local checkout does not contain it.
 */
export function historyContains(repoPath: string, sha: string): boolean {
  if (!COMMIT_SHA_RE.test(sha)) return false;
  try {
    runGit(['cat-file', '-e', `${sha}^{commit}`], repoPath);
    runGit(['merge-base', '--is-ancestor', sha, 'HEAD'], repoPath);
    return true;
  } catch {
    return false;
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

/**
 * Paths whose content differs between `ref` and HEAD. Two-dot = tree vs tree:
 * every path the remote would see change if HEAD were pushed — including files
 * the REMOTE changed since our base (a force-push would silently revert those).
 */
export function pathsDifferingFrom(repoPath: string, ref: string): string[] {
  return splitLines(runGit(['diff', '--name-only', ref, 'HEAD'], repoPath));
}

function splitLines(out: string): string[] {
  return out.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
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

export function ensureGitRepository(repoPath: string) {
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    runGit(['init'], repoPath);
  }
  ensureGitignore(repoPath);
}

// ---- Branches (the toolbar branch switcher) ----------------------------------

// Branch names flow into git argv: must start with an alnum (never an option)
// and additionally pass git's own ref-name rules.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u;

/** Whether `name` is a safe, valid git branch name. */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_NAME_RE.test(name) || name.includes('..')) return false;
  const res = spawnSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return res.status === 0 && res.stdout.trim() === name;
}

/** The checked-out local branch, or null when HEAD is detached / unborn. */
export function currentLocalBranch(repoPath: string): string | null {
  try {
    return runGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoPath) || null;
  } catch {
    return null;
  }
}

export function localBranchNames(repoPath: string): string[] {
  try {
    return splitLines(runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath));
  } catch {
    return [];
  }
}

/**
 * Fetch `branch` from the remote into FETCH_HEAD. False when the remote has no
 * such branch; any other failure (network, auth) throws — a "not found" must
 * never be reported for a remote we simply couldn't reach.
 */
export function fetchRemoteBranch(repoPath: string, branch: string, remoteUrl: string): boolean {
  try {
    runGit(['fetch', remoteUrl, `refs/heads/${branch}`], repoPath);
    return true;
  } catch (error) {
    if (error instanceof GitError && /couldn't find remote ref|could not find remote ref/iu.test(error.output ?? '')) return false;
    throw error;
  }
}

/**
 * Make sure the checked-out local branch is called `name`. Older checkouts sit on
 * a local branch whose name differs from the branch they publish to (`git init`
 * gives `master`, publishing maps HEAD:main); switching branches relies on local
 * names matching, so the current line of work is renamed before leaving it.
 */
export function adoptBranchName(repoPath: string, name: string): void {
  const current = currentLocalBranch(repoPath);
  if (current === name) return;
  if (localBranchNames(repoPath).includes(name)) return; // never clobber an existing local branch
  if (current === null) runGit(['checkout', '-b', name], repoPath);
  else runGit(['branch', '-m', current, name], repoPath);
}

export interface BranchSwitchResult {
  before: string | null;
  after: string | null;
  changedFiles: string[];
  /** The local branch has commits the remote lacks AND vice versa (next sync/publish reconciles). */
  diverged: boolean;
}

/**
 * Check out `target` (the tree must be clean — the caller commits first). A local
 * branch keeps its own unpublished commits and is only fast-forwarded to the
 * remote; a remote-only branch gets a local tracking copy. Never resets a branch
 * (`checkout -B` would silently drop unpublished local commits).
 */
export function switchLocalBranch(repoPath: string, target: string, remoteUrl?: string): BranchSwitchResult {
  if (runGit(['status', '--porcelain'], repoPath).trim().length > 0) {
    throw new GitError('Cannot switch branches with uncommitted changes.');
  }
  const before = revParseHead(repoPath);
  const onRemote = remoteUrl ? fetchRemoteBranch(repoPath, target, remoteUrl) : false; // local-only repo: no remote
  let diverged = false;
  if (localBranchNames(repoPath).includes(target)) {
    runGit(['checkout', target, '--'], repoPath);
    if (onRemote) {
      try {
        runGit(['merge', '--ff-only', 'FETCH_HEAD'], repoPath);
      } catch {
        diverged = !historyContains(repoPath, runGit(['rev-parse', 'FETCH_HEAD'], repoPath));
      }
    }
  } else if (onRemote) {
    runGit(['checkout', '-b', target, 'FETCH_HEAD'], repoPath);
  } else {
    throw new GitError(`Branch '${target}' does not exist.`);
  }
  const after = revParseHead(repoPath);
  return { before, after, changedFiles: diffNames(repoPath, before, after), diverged };
}

/**
 * Merge local branch `source` into local branch `target` WITHOUT touching the
 * working tree: the merge is computed in the object store (`merge-tree
 * --write-tree`), committed with both parents and `target` is moved with a
 * compare-and-swap. The checked-out branch, its files and the running preview
 * never change; a conflict leaves everything exactly as it was.
 */
export function mergeLocalBranch(repoPath: string, source: string, target: string): 'merged' | 'nothing' {
  if (!localBranchNames(repoPath).includes(target)) throw new GitError(`Branch '${target}' does not exist.`);
  const sourceSha = runGit(['rev-parse', '--verify', `refs/heads/${source}^{commit}`], repoPath);
  const targetSha = runGit(['rev-parse', '--verify', `refs/heads/${target}^{commit}`], repoPath);
  try {
    runGit(['merge-base', '--is-ancestor', sourceSha, targetSha], repoPath);
    return 'nothing'; // target already contains everything from source
  } catch { /* not merged yet */ }
  let tree: string;
  try {
    tree = runGit(['merge-tree', '--write-tree', '--no-messages', targetSha, sourceSha], repoPath).split(/\r?\n/u)[0].trim();
  } catch (error) {
    const detail = error instanceof GitError ? error.output ?? '' : '';
    const conflicted = splitLines(detail).slice(1).map((l) => l.split('\t').pop() ?? l).filter(Boolean);
    throw new GitError(
      `Merge conflict: '${source}' and '${target}' both changed the same lines${conflicted.length ? ` (${[...new Set(conflicted)].slice(0, 5).join(', ')})` : ''}. Nothing was merged — resolve it on '${source}' first (e.g. ask the agent to bring '${target}' into this branch), then merge again.`,
      detail || undefined,
    );
  }
  if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new GitError('Could not merge: unexpected merge result.');
  const commit = runGit(['commit-tree', tree, '-p', targetSha, '-p', sourceSha, '-m', `Merge branch '${source}' into ${target}`], repoPath);
  // Compare-and-swap: refuses if `target` moved meanwhile.
  runGit(['update-ref', '-m', `merge ${source}`, `refs/heads/${target}`, commit, targetSha], repoPath);
  return 'merged';
}

/** Create `name` from the current HEAD and check it out (local only until published). */
export function createLocalBranch(repoPath: string, name: string): void {
  runGit(['checkout', '-b', name], repoPath);
}

/**
 * Paths HEAD changes relative to its common ancestor with `ref` (three-dot): what
 * merging HEAD into `ref` would bring in — not what `ref` gained meanwhile.
 */
export function pathsChangedSinceMergeBase(repoPath: string, ref: string): string[] {
  return splitLines(runGit(['diff', '--name-only', `${ref}...HEAD`], repoPath));
}

/** The `origin` remote URL, or null when there is none. */
export function originUrl(repoPath: string): string | null {
  try {
    return runGit(['remote', 'get-url', 'origin'], repoPath) || null;
  } catch {
    return null;
  }
}
