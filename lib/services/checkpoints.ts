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
import { HARDENED_GIT_ARGS, gitEnv } from '@/lib/services/git';

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR) ? PROJECTS_DIR : path.resolve(process.cwd(), PROJECTS_DIR);
const CHECKPOINTS_ROOT = path.resolve(PROJECTS_DIR_ABSOLUTE, '..', 'checkpoints');

// Never snapshot deps/build output or the project's own git dir. Also never
// snapshot the per-turn agent MCP config — it carries a live capability token
// (revoked at turn end, but must not be captured into a checkpoint mid-turn).
const EXCLUDES = ['.git', 'node_modules', '.next', '.nuxt', '.output', 'dist', '.vite', '.turbo', '.cache', 'coverage', '.claudable/agent-mcp.json'];
const MAX_GIT_OUTPUT = 512 * 1024; // cap captured stdout/stderr per git call

function gitDir(projectId: string): string {
  // Defense-in-depth: never let a crafted projectId escape CHECKPOINTS_ROOT (the
  // shadow GIT_DIR pairs with a work-tree where `git clean -fd` runs on revert).
  const dir = path.resolve(CHECKPOINTS_ROOT, projectId);
  if (dir !== CHECKPOINTS_ROOT && !dir.startsWith(CHECKPOINTS_ROOT + path.sep)) {
    throw new Error('Invalid projectId for checkpoint repo');
  }
  return dir;
}

// Hard ceiling on any single git op. Ops are serialized through withLock, so a
// hung git (index-lock contention, a pathological `git add -A` on an accidentally
// tracked huge tree) would otherwise block ALL future checkpoints/reverts for the
// project — invisibly, since checkpointTurn is void-fired. Kill + fail instead.
const GIT_TIMEOUT_MS = Number(process.env.CHECKPOINT_GIT_TIMEOUT_MS || 120_000);

function git(projectId: string, projectPath: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return gitRaw(projectId, projectPath, args, MAX_GIT_OUTPUT).then((r) => ({ ok: r.ok, out: r.out.toString('utf8').trim() }));
}

/** git with the untouched stdout (file contents: no trim, own size cap). stderr only on failure. */
function gitRaw(projectId: string, projectPath: string, args: string[], maxBytes: number): Promise<{ ok: boolean; out: Buffer }> {
  return new Promise((resolve) => {
    // Hardened like every other git call on project content: the work tree is
    // agent-written, so no hooks/fsmonitor/pager and no Claudable secrets in env.
    const child = spawn('git', [...HARDENED_GIT_ARGS, ...args], {
      cwd: projectPath,
      env: { ...gitEnv(), GIT_DIR: gitDir(projectId), GIT_WORK_TREE: projectPath },
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let settled = false;
    const done = (r: { ok: boolean; out: Buffer }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ ok: false, out: Buffer.from(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`) });
    }, GIT_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => { if (size < maxBytes) { chunks.push(d); size += d.length; } });
    child.stderr?.on('data', (d: Buffer) => { if (errSize < MAX_GIT_OUTPUT) { errChunks.push(d); errSize += d.length; } });
    child.on('error', (e) => done({ ok: false, out: Buffer.from(String(e?.message || e)) }));
    child.on('close', (code) => {
      const out = Buffer.concat(chunks).subarray(0, maxBytes);
      done(code === 0 ? { ok: true, out } : { ok: false, out: Buffer.concat([out, ...errChunks]) });
    });
  });
}

// Per-project serialization: chain each op after the previous one for that repo
// so concurrent checkpoint/revert calls never fight over .git/index.lock.
const queues = new Map<string, Promise<unknown>>();
function withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(projectId, tail);
  // Drop the entry once this is the last queued op, so the map doesn't retain a
  // settled promise per project for the process lifetime.
  tail.then(() => { if (queues.get(projectId) === tail) queues.delete(projectId); });
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

/** Snapshot now (if anything changed) and return the current HEAD: the pre-turn baseline. */
export async function checkpointBaseline(projectId: string, projectPath: string, message: string): Promise<string | null> {
  await createCheckpoint(projectId, projectPath, message);
  return withLock(projectId, async () => {
    const head = await git(projectId, projectPath, ['rev-parse', '--verify', 'HEAD']);
    return head.ok && /^[0-9a-f]{40}$/iu.test(head.out) ? head.out : null;
  });
}

export type CheckpointChange = { status: 'A' | 'M' | 'D'; path: string };

/** Files added/modified/deleted in the work-tree since `sha` (stages them; the next checkpoint commits). */
export function changedPathsSince(projectId: string, projectPath: string, sha: string): Promise<CheckpointChange[] | null> {
  return withLock(projectId, async () => {
    if (!(await checkpointExistsUnlocked(projectId, projectPath, sha))) return null;
    await git(projectId, projectPath, ['add', '-A']);
    const diff = await gitRaw(projectId, projectPath, ['diff', '--cached', '--name-status', '-z', '--no-renames', sha], 16 * 1024 * 1024);
    if (!diff.ok) return null;
    const parts = diff.out.toString('utf8').split('\0').filter((x) => x !== '');
    const changes: CheckpointChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i][0];
      const status = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
      changes.push({ status, path: parts[i + 1] });
    }
    return changes;
  });
}

/** A file's content at a checkpoint, or null when it did not exist there. */
export function readFileAtCheckpoint(projectId: string, projectPath: string, sha: string, relPath: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
  return withLock(projectId, async () => {
    if (!/^[0-9a-f]{7,40}$/iu.test(sha)) return null;
    const r = await gitRaw(projectId, projectPath, ['cat-file', 'blob', `${sha}:${relPath}`], maxBytes);
    return r.ok ? r.out : null;
  });
}

/**
 * Put individual paths back to how they were at `sha`: files that existed are
 * restored, files that did not are deleted. Everything else is left alone.
 */
export function restorePathsFromCheckpoint(
  projectId: string,
  projectPath: string,
  sha: string,
  paths: { path: string; existed: boolean }[],
): Promise<{ ok: boolean; error?: string }> {
  return withLock(projectId, async () => {
    if (!(await checkpointExistsUnlocked(projectId, projectPath, sha))) return { ok: false, error: 'Checkpoint not found' };
    const root = path.resolve(projectPath);
    const inside = (p: string) => {
      const abs = path.resolve(root, p);
      return abs.startsWith(root + path.sep) ? abs : null;
    };
    const literal = (p: string) => `:(literal)${p}`;
    const existed = paths.filter((p) => p.existed && inside(p.path)).map((p) => p.path);
    const added = paths.filter((p) => !p.existed && inside(p.path)).map((p) => p.path);
    const errors: string[] = [];
    if (existed.length) {
      const r = await git(projectId, projectPath, ['restore', '--source', sha, '--staged', '--worktree', '--', ...existed.map(literal)]);
      if (!r.ok) errors.push(r.out.slice(0, 300));
    }
    for (const p of added) {
      const abs = inside(p);
      if (abs) await fs.promises.rm(abs, { force: true }).catch((e) => errors.push(String(e)));
    }
    if (added.length) await git(projectId, projectPath, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...added.map(literal)]);
    return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
  });
}
