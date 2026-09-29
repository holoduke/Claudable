/**
 * Edit profiles, layer 3: the backstop after an agent turn.
 *
 * Before a turn by someone with a restricted profile we snapshot the project
 * (a checkpoint = the baseline). After the turn every file that differs from the
 * baseline is classified with the same rules as the guard hook; anything the
 * profile does not allow is put back and the chat says so. This catches writes
 * that did not go through the Write/Edit tools (e.g. an MCP tool).
 *
 * Files Claudable itself or the running preview (re)writes during a turn are
 * skipped here — they are not the agent's doing, and the hook already stops the
 * agent from touching them.
 *
 * Known limit: the shadow checkpoint repo honours the project's .gitignore, so
 * ignored paths (.env, .data/, build output) are invisible to this diff. Snapshotting
 * them would drag secrets and databases into every checkpoint and revert. For a
 * restricted profile the only file-writing tools are Write/Edit (tool allowlist, no
 * shell, no MCP), and the guard hook classifies every path they touch — dot-files
 * and unknown files as code.
 */
import fs from 'fs/promises';
import path from 'path';
import { changedPathsSince, checkpointBaseline, readFileAtCheckpoint, restorePathsFromCheckpoint } from '@/lib/services/checkpoints';
import { changeAllowed, classifyFileChange, describeKinds, isRestricted, resolveEditProfile, type EditKind, type EditProfile } from '@/lib/services/edit-profiles';
import { createMessage } from '@/lib/services/message';
import { streamManager } from '@/lib/services/stream';
import { serializeMessage } from '@/lib/serializers/chat';

export interface TurnEditGuard {
  projectId: string;
  projectPath: string;
  profile: EditProfile;
  baselineSha: string | null;
}

export type Violation = { path: string; kinds: EditKind[] };

const MANAGED_PATHS = [
  /(^|\/)claudable-preview\.client\.ts$/,
  /^\.claudable\//,
  /^\.data\//,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock)$/,
  /(^|\/)(next-env|components|auto-imports|typed-router|components\.d)\.d\.ts$/,
  /\.tsbuildinfo$/,
];

export const isManagedPath = (rel: string): boolean => MANAGED_PATHS.some((re) => re.test(rel));

/** Lines Claudable itself appends to a project's .gitignore (SQLite dir, preview plugin). */
const MANAGED_GITIGNORE_LINE = /^(\/?\.data\/?|\/?[\w./-]*claudable-preview\.client\.ts)$/;

/** True when .gitignore only gained Claudable's own lines at the end. */
export function isManagedGitignoreChange(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  const base = before ?? '';
  if (!after.startsWith(base)) return false;
  return after.slice(base.length).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).every((l) => MANAGED_GITIGNORE_LINE.test(l));
}

/** Resolve the requester's profile; for a restricted one, snapshot the baseline. Null = unrestricted. */
export async function prepareTurnEditGuard(projectId: string, projectPath: string, userId: string | null | undefined): Promise<TurnEditGuard | null> {
  const { profile } = await resolveEditProfile(projectId, userId);
  if (!isRestricted(profile)) return null;
  const baselineSha = await checkpointBaseline(projectId, projectPath, `Before turn (edit profile: ${profile.label})`).catch((e) => {
    console.error(`[edit-profiles] baseline checkpoint failed for ${projectId}:`, e);
    return null;
  });
  if (!baselineSha) console.error(`[edit-profiles] no baseline for ${projectId}: the post-turn check cannot run this turn (the hook still applies)`);
  return { projectId, projectPath, profile, baselineSha };
}

async function readCurrent(projectPath: string, rel: string): Promise<string | null> {
  const abs = path.resolve(projectPath, rel);
  if (!abs.startsWith(path.resolve(projectPath) + path.sep)) return null;
  try {
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Classify every change since the baseline; returns the ones the profile does not allow. */
export async function findViolations(guard: TurnEditGuard): Promise<Violation[] | null> {
  if (!guard.baselineSha) return null;
  const changes = await changedPathsSince(guard.projectId, guard.projectPath, guard.baselineSha);
  if (!changes) return null;
  const violations: Violation[] = [];
  for (const change of changes) {
    if (isManagedPath(change.path)) continue;
    const before = change.status === 'A'
      ? null
      : (await readFileAtCheckpoint(guard.projectId, guard.projectPath, guard.baselineSha, change.path))?.toString('utf8') ?? null;
    const after = change.status === 'D' ? null : await readCurrent(guard.projectPath, change.path);
    if (change.path === '.gitignore' && isManagedGitignoreChange(before, after)) continue;
    const kinds = classifyFileChange(change.path, before, after);
    if (!changeAllowed(guard.profile, kinds, change.path)) violations.push({ path: change.path, kinds: [...kinds] });
  }
  return violations;
}

async function postNotice(projectId: string, requestId: string | undefined, content: string): Promise<void> {
  try {
    const msg = await createMessage({ projectId, role: 'system', messageType: 'info', content, cliSource: 'claude', ...(requestId ? { requestId } : {}) });
    streamManager.publish(projectId, { type: 'message', data: serializeMessage(msg, requestId ? { requestId } : undefined) });
  } catch (e) {
    console.error('[edit-profiles] failed to post notice:', e);
  }
}

/** Run after the turn (before its checkpoint): put back what the profile does not allow. Never throws. */
export async function enforceTurnEditProfile(guard: TurnEditGuard, requestId?: string): Promise<Violation[]> {
  try {
    const violations = await findViolations(guard);
    if (!violations || violations.length === 0) return [];
    const baseline = guard.baselineSha as string;
    const result = await restorePathsFromCheckpoint(
      guard.projectId,
      guard.projectPath,
      baseline,
      await Promise.all(violations.map(async (v) => ({
        path: v.path,
        existed: (await readFileAtCheckpoint(guard.projectId, guard.projectPath, baseline, v.path, 1)) !== null,
      }))),
    );
    const list = violations.slice(0, 8).map((v) => `• ${v.path} (${describeKinds(v.kinds)})`).join('\n');
    const more = violations.length > 8 ? `\n… and ${violations.length - 8} more` : '';
    const head = result.ok
      ? `🔒 Edit profile "${guard.profile.label}": ${violations.length === 1 ? 'this change was' : 'these changes were'} undone because the profile does not allow ${violations.length === 1 ? 'it' : 'them'}:`
      : `🔒 Edit profile "${guard.profile.label}": these changes are outside the profile, but undoing them did not fully succeed (${result.error}). Ask someone with full edit rights to take a look:`;
    await postNotice(guard.projectId, requestId, `${head}\n${list}${more}`);
    console.warn(`[edit-profiles] ${guard.projectId}: ${violations.length} violation(s) ${result.ok ? 'reverted' : 'NOT fully reverted'}: ${violations.map((v) => v.path).join(', ')}`);
    return violations;
  } catch (e) {
    console.error(`[edit-profiles] post-turn check failed for ${guard.projectId}:`, e);
    return [];
  }
}
