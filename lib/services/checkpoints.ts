/**
 * Per-project CHECKPOINTS — a lightweight snapshot of the project's source after
 * each agent turn, so any turn can be reverted with one click.
 *
 * Implemented as a SHADOW git repo (its own GIT_DIR) whose work-tree is the
 * project directory. This keeps checkpoint history completely separate from the
 * project's own deploy repo (.git) — snapshotting/reverting here never touches
 * the branch that gets published.
 *
 * Revert is a forward-restore (checkout the old tree into the work-tree + a new
 * checkpoint), never a history rewrite.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(process.cwd(), PROJECTS_DIR);
const CHECKPOINTS_ROOT = path.resolve(PROJECTS_DIR_ABSOLUTE, '..', 'checkpoints');

// Never snapshot deps/build output or the project's own git dir.
const EXCLUDES = ['.git', 'node_modules', '.next', '.nuxt', '.output', 'dist', '.vite', '.turbo', '.cache', 'coverage'];

function gitDir(projectId: string): string {
  return path.join(CHECKPOINTS_ROOT, projectId);
}

function git(projectId: string, projectPath: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync('git', args, {
    cwd: projectPath,
    env: { ...process.env, GIT_DIR: gitDir(projectId), GIT_WORK_TREE: projectPath },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  });
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

/** Create the shadow repo (idempotent) with our excludes + a committer identity. */
export function ensureCheckpointRepo(projectId: string, projectPath: string): void {
  const dir = gitDir(projectId);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true });
    git(projectId, projectPath, ['init', '-q']);
    git(projectId, projectPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(projectId, projectPath, ['config', 'user.name', 'Claudable']);
    git(projectId, projectPath, ['config', 'user.email', 'checkpoints@claudable.local']);
    git(projectId, projectPath, ['config', 'core.autocrlf', 'false']);
  }
  // Keep the exclude list current (info/exclude lives in the GIT_DIR).
  try { fs.writeFileSync(path.join(dir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n'); } catch { /* ignore */ }
}

/** Snapshot the current source. Returns the new commit sha, or null if nothing changed. */
export function createCheckpoint(projectId: string, projectPath: string, message: string): string | null {
  try {
    if (!fs.existsSync(projectPath)) return null;
    ensureCheckpointRepo(projectId, projectPath);
    git(projectId, projectPath, ['add', '-A']);
    const status = git(projectId, projectPath, ['status', '--porcelain']);
    const hasHead = git(projectId, projectPath, ['rev-parse', '--verify', 'HEAD']).ok;
    if (hasHead && status.out.length === 0) return null; // nothing new to snapshot
    const commit = git(projectId, projectPath, ['commit', '-q', '--no-verify', '-m', message.slice(0, 200)]);
    if (!commit.ok) return null;
    const sha = git(projectId, projectPath, ['rev-parse', 'HEAD']);
    return sha.ok ? sha.out : null;
  } catch {
    return null;
  }
}

export function checkpointExists(projectId: string, projectPath: string, sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/iu.test(sha)) return false;
  return git(projectId, projectPath, ['cat-file', '-t', sha]).out === 'commit';
}

/**
 * Restore the work-tree to a checkpoint (forward-restore): make the tracked files
 * match `sha`, delete files added since, then record the restore as a new
 * checkpoint. Non-destructive to checkpoint history.
 */
export function revertToCheckpoint(projectId: string, projectPath: string, sha: string): { ok: boolean; error?: string; newSha?: string | null } {
  if (!checkpointExists(projectId, projectPath, sha)) return { ok: false, error: 'Checkpoint not found' };
  // Restore tracked files to the checkpoint, and remove files that didn't exist then.
  const restore = git(projectId, projectPath, ['restore', '--source', sha, '--staged', '--worktree', '--', '.']);
  if (!restore.ok) {
    // Fallback for older git: checkout the tree.
    const co = git(projectId, projectPath, ['checkout', sha, '--', '.']);
    if (!co.ok) return { ok: false, error: co.out || 'restore failed' };
  }
  git(projectId, projectPath, ['clean', '-fd', '-e', 'node_modules', '-e', '.next', '-e', '.nuxt', '-e', '.output', '-e', 'dist']);
  const newSha = createCheckpoint(projectId, projectPath, `Revert to ${sha.slice(0, 8)}`);
  return { ok: true, newSha };
}
