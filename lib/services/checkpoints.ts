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
 *
 * All git runs ASYNC (spawn, not spawnSync) so a large `git add -A` never blocks
 * the Next.js event loop, and every op for a given project is SERIALIZED through
 * a per-project queue so a turn's snapshot can't collide with a concurrent
 * revert on the same repo's index.lock.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(process.cwd(), PROJECTS_DIR);
const CHECKPOINTS_ROOT = path.resolve(PROJECTS_DIR_ABSOLUTE, '..', 'checkpoints');

// Never snapshot deps/build output or the project's own git dir.
const EXCLUDES = ['.git', 'node_modules', '.next', '.nuxt', '.output', 'dist', '.vite', '.turbo', '.cache', 'coverage'];
const MAX_GIT_OUTPUT = 512 * 1024; // cap captured stdout/stderr per git call

function gitDir(projectId: string): string {
  return path.join(CHECKPOINTS_ROOT, projectId);
}

function git(projectId: string, projectPath: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: projectPath,
      env: { ...process.env, GIT_DIR: gitDir(projectId), GIT_WORK_TREE: projectPath },
    });
    let out = '';
    const collect = (d: Buffer) => { if (out.length < MAX_GIT_OUTPUT) out += d.toString('utf8'); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (e) => resolve({ ok: false, out: String(e?.message || e) }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

// Per-project serialization: chain each op after the previous one for that repo
// so concurrent checkpoint/revert calls never fight over .git/index.lock.
const queues = new Map<string, Promise<unknown>>();
function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(projectId, next.catch(() => {}));
  return next;
}

/** Create the shadow repo (idempotent) with our excludes + a committer identity. */
async function ensureCheckpointRepo(projectId: string, projectPath: string): Promise<void> {
  const dir = gitDir(projectId);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) {
    fs.mkdirSync(dir, { recursive: true });
    await git(projectId, projectPath, ['init', '-q']);
    await git(projectId, projectPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(projectId, projectPath, ['config', 'user.name', 'Claudable']);
    await git(projectId, projectPath, ['config', 'user.email', 'checkpoints@claudable.local']);
    await git(projectId, projectPath, ['config', 'core.autocrlf', 'false']);
  }
  // Keep the exclude list current (info/exclude lives in the GIT_DIR).
  try { fs.writeFileSync(path.join(dir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n'); } catch { /* ignore */ }
}

/** Snapshot the current source. Returns the new commit sha, or null if unchanged. */
export function createCheckpoint(projectId: string, projectPath: string, message: string): Promise<string | null> {
  return withLock(projectId, async () => {
    try {
      if (!fs.existsSync(projectPath)) return null;
      await ensureCheckpointRepo(projectId, projectPath);
      await git(projectId, projectPath, ['add', '-A']);
      const status = await git(projectId, projectPath, ['status', '--porcelain']);
      const hasHead = (await git(projectId, projectPath, ['rev-parse', '--verify', 'HEAD'])).ok;
      if (hasHead && status.out.length === 0) return null; // nothing new to snapshot
      const commit = await git(projectId, projectPath, ['commit', '-q', '--no-verify', '-m', message.slice(0, 200)]);
      if (!commit.ok) { console.warn(`[checkpoints] commit failed for ${projectId}: ${commit.out.slice(0, 300)}`); return null; }
      const sha = await git(projectId, projectPath, ['rev-parse', 'HEAD']);
      return sha.ok ? sha.out : null;
    } catch (e) {
      console.warn(`[checkpoints] createCheckpoint error for ${projectId}:`, e);
      return null;
    }
  });
}

async function checkpointExistsUnlocked(projectId: string, projectPath: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/iu.test(sha)) return false;
  return (await git(projectId, projectPath, ['cat-file', '-t', sha])).out === 'commit';
}

export function checkpointExists(projectId: string, projectPath: string, sha: string): Promise<boolean> {
  return withLock(projectId, () => checkpointExistsUnlocked(projectId, projectPath, sha));
}

/**
 * Restore the work-tree to a checkpoint (forward-restore): make the tracked files
 * match `sha`, delete files added since, then record the restore as a new
 * checkpoint. Non-destructive to checkpoint history. `git clean` relies on
 * info/exclude (the single EXCLUDES source) to spare node_modules/build output.
 */
export function revertToCheckpoint(
  projectId: string,
  projectPath: string,
  sha: string,
): Promise<{ ok: boolean; error?: string; newSha?: string | null }> {
  return withLock(projectId, async () => {
    if (!(await checkpointExistsUnlocked(projectId, projectPath, sha))) return { ok: false, error: 'Checkpoint not found' };
    // Restore tracked files to the checkpoint, and remove files that didn't exist then.
    const restore = await git(projectId, projectPath, ['restore', '--source', sha, '--staged', '--worktree', '--', '.']);
    if (!restore.ok) {
      // Fallback for older git: checkout the tree.
      const co = await git(projectId, projectPath, ['checkout', sha, '--', '.']);
      if (!co.ok) return { ok: false, error: co.out || 'restore failed' };
    }
    // -fd removes newly-added files/dirs; info/exclude keeps deps/build output safe.
    const cleaned = await git(projectId, projectPath, ['clean', '-fd']);
    if (!cleaned.ok) console.warn(`[checkpoints] clean failed for ${projectId}: ${cleaned.out.slice(0, 300)}`);
    // Record the restore as a new checkpoint (inline — we already hold the lock).
    let newSha: string | null = null;
    try {
      await git(projectId, projectPath, ['add', '-A']);
      const commit = await git(projectId, projectPath, ['commit', '-q', '--no-verify', '-m', `Revert to ${sha.slice(0, 8)}`]);
      if (commit.ok) { const r = await git(projectId, projectPath, ['rev-parse', 'HEAD']); newSha = r.ok ? r.out : null; }
    } catch { /* the revert itself succeeded; the bookkeeping commit is best-effort */ }
    return { ok: true, newSha };
  });
}
