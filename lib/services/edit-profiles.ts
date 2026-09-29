/**
 * Edit profiles: WHAT a person may let the agent change
 * in a project — everything, only texts, only styling, texts + styling, or a
 * custom set. Stored per project in Project.settings.editProfiles:
 *
 *   { default: 'content', members: { <userId>: 'full' }, custom: { … } }
 *
 * `default` applies to every writer who is not exempt; `members` overrides it per
 * person. Exempt (always "full"): global admins, the project owner, and — in a
 * customer project — New Story staff (they configure it; the customer uses it).
 *
 * Enforced in three layers:
 *   1. the agent's system prompt (editProfilePromptNote) — it knows the rules;
 *   2. a PreToolUse hook on every file edit (lib/edit-guard/guard.cjs) — blocked
 *      before it happens, Bash off for restricted profiles;
 *   3. after the turn, a diff against the pre-turn checkpoint (edit-profile-enforce.ts)
 *      — anything that still slipped through is put back.
 * The file editor and visual editor routes use the same classifier (assertEditAllowed).
 */
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { isCustomerProject, isInternalUser } from '@/lib/services/tenant-policy';
import classifyModule from '@/lib/edit-guard/classify.cjs';

// Plain CommonJS (it also runs as a hook inside the agent container), so type it here.
const classify = classifyModule as unknown as {
  PROFILES: Record<BuiltinProfileId, { id: string; kinds: EditKind[] }>;
  classifyChange: (path: string, before: string | null, after: string | null) => Set<EditKind>;
  isAllowed: (profile: EditProfile, kinds: Set<EditKind>, path?: string) => boolean;
  describeKinds: (kinds: Set<EditKind>) => string;
};

export type EditKind = 'text' | 'style' | 'asset' | 'code';
export type BuiltinProfileId = 'full' | 'content' | 'style' | 'content-style';
export type ProfileId = BuiltinProfileId | 'custom';

export interface EditProfile {
  id: ProfileId;
  label: string;
  description: string;
  kinds: EditKind[];
  allowPaths?: string[];
  denyPaths?: string[];
}

export const PROFILE_IDS: readonly ProfileId[] = ['full', 'content', 'style', 'content-style', 'custom'];

const BUILTIN_META: Record<BuiltinProfileId, { label: string; description: string }> = {
  full: { label: 'Everything', description: 'May change anything: text, styling, structure and code.' },
  content: { label: 'Text only', description: 'Texts, links and images. No layout, styling or code.' },
  style: { label: 'Styling only', description: 'Colours, fonts, sizes and spacing (classes, CSS, theme). No text or code.' },
  'content-style': { label: 'Text + styling', description: 'Texts, images and styling. No structure or code.' },
};

const KIND_ENUM = z.enum(['text', 'style', 'asset', 'code']);
const GLOB = z.string().trim().min(1).max(200).regex(/^[^\0]+$/u).refine((g) => !g.includes('..'), 'no ..');

export const customProfileSchema = z.object({
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  kinds: z.array(KIND_ENUM).min(1).max(4),
  allowPaths: z.array(GLOB).max(50).default([]),
  denyPaths: z.array(GLOB).max(50).default([]),
});

export const editProfileConfigSchema = z.object({
  default: z.enum(['full', 'content', 'style', 'content-style', 'custom']).default('full'),
  members: z.record(z.string().min(1).max(64), z.enum(['full', 'content', 'style', 'content-style', 'custom'])).default({}),
  custom: customProfileSchema.nullable().default(null),
});

export type EditProfileConfig = z.infer<typeof editProfileConfigSchema>;

export const DEFAULT_EDIT_PROFILE_CONFIG: EditProfileConfig = Object.freeze({ default: 'full', members: {}, custom: null }) as EditProfileConfig;

export function builtinProfile(id: BuiltinProfileId): EditProfile {
  return { id, ...BUILTIN_META[id], kinds: [...classify.PROFILES[id].kinds] };
}

/** The profile object for an id under a config (custom falls back to "content" when undefined: fail closed). */
export function profileFor(id: ProfileId, config: EditProfileConfig): EditProfile {
  if (id !== 'custom') return builtinProfile(id);
  const c = config.custom;
  if (!c) return builtinProfile('content');
  return { id: 'custom', label: c.label, description: c.description, kinds: [...c.kinds], allowPaths: [...c.allowPaths], denyPaths: [...c.denyPaths] };
}

export function isRestricted(profile: EditProfile): boolean {
  return !profile.kinds.includes('code') || (profile.allowPaths?.length ?? 0) > 0 || (profile.denyPaths?.length ?? 0) > 0;
}

/** Parse the stored config; a corrupt value restricts to "content" rather than silently opening up. */
export function parseEditProfileConfig(settingsJson: string | null | undefined): EditProfileConfig {
  if (!settingsJson) return DEFAULT_EDIT_PROFILE_CONFIG;
  let raw: unknown;
  try {
    raw = (JSON.parse(settingsJson) as Record<string, unknown>)?.editProfiles;
  } catch {
    return DEFAULT_EDIT_PROFILE_CONFIG;
  }
  if (raw === undefined || raw === null) return DEFAULT_EDIT_PROFILE_CONFIG;
  const parsed = editProfileConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.error('[edit-profiles] invalid editProfiles config, falling back to "content":', parsed.error.message);
  return { default: 'content', members: {}, custom: null };
}

export async function getEditProfileConfig(projectId: string): Promise<EditProfileConfig> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { settings: true } });
  return parseEditProfileConfig(project?.settings);
}

export async function saveEditProfileConfig(projectId: string, config: EditProfileConfig): Promise<EditProfileConfig> {
  const valid = editProfileConfigSchema.parse(config);
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { settings: true } });
  let settings: Record<string, unknown> = {};
  try {
    settings = project?.settings ? (JSON.parse(project.settings) as Record<string, unknown>) : {};
  } catch {
    settings = {};
  }
  const next = { ...settings, editProfiles: valid };
  await prisma.project.update({ where: { id: projectId }, data: { settings: JSON.stringify(next) } });
  return valid;
}

export type ProfileResolution = { profile: EditProfile; source: 'exempt' | 'member' | 'default' | 'no-user' };

/** The profile that applies to `userId` in this project. */
export async function resolveEditProfile(projectId: string, userId: string | null | undefined): Promise<ProfileResolution> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true, settings: true } });
  const config = parseEditProfileConfig(project?.settings);
  if (!userId) return { profile: builtinProfile('full'), source: 'no-user' };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) return { profile: profileFor(config.default, config), source: 'default' };
  if (user.role === 'admin' || project?.ownerId === user.id) return { profile: builtinProfile('full'), source: 'exempt' };
  if ((await isCustomerProject(projectId)) && (await isInternalUser(user))) return { profile: builtinProfile('full'), source: 'exempt' };
  const memberId = config.members[user.id];
  if (memberId) return { profile: profileFor(memberId, config), source: 'member' };
  return { profile: profileFor(config.default, config), source: 'default' };
}

const KIND_PROMPT: Record<EditKind, string> = {
  text: 'visible copy — headings, paragraphs, button/link labels, alt texts, link targets, and content/locale files (Markdown, translation JSON)',
  style: 'styling — static class/className/style attribute values, CSS files and style blocks, colours/fonts in tailwind.config / app.config',
  asset: 'images and media files (e.g. generating or replacing a picture)',
  code: 'code and structure',
};

/** Layer 1: the agent's instructions for a restricted profile ('' for full access). */
export function editProfilePromptNote(profile: EditProfile): string {
  if (!isRestricted(profile)) return '';
  const allowed = profile.kinds.filter((k) => k !== 'code').map((k) => `- ${KIND_PROMPT[k]}`).join('\n');
  const paths = [
    profile.allowPaths?.length ? `Only these files may be changed: ${profile.allowPaths.join(', ')}.` : '',
    profile.denyPaths?.length ? `Never change: ${profile.denyPaths.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  const codeLine = profile.kinds.includes('code')
    ? ''
    : 'You may NOT add, remove or reorder elements/components, change scripts, logic, imports, props, directives or event handlers, create new code files, or touch configuration, packages or server code. Shell commands are unavailable.';
  return `\n\n## Edit profile: ${profile.label}\nThe person you are working for has a restricted edit profile. You may only change:\n${allowed || '- nothing'}\n${codeLine}${paths ? `\n${paths}` : ''}${profile.description ? `\nProfile note from the project owner: ${profile.description}` : ''}\nEdits outside this profile are blocked automatically and any that slip through are reverted after your turn. An edit that mixes allowed and disallowed changes is blocked as a whole, so make each allowed change as its own small edit. If a request needs a change outside the profile, do what IS allowed (if anything), then tell the user plainly — in their language — which part needs someone with full edit rights. Never try to work around the restriction.`;
}

/**
 * The ONLY built-in tools a restricted profile gets (an allowlist: new CLI tools
 * stay off by default). Nothing that runs commands (Bash, Monitor, Workflow, Cron),
 * spawns sub-agents (Task) or leaves the work-tree (worktrees). MCP tools are separate.
 */
export const RESTRICTED_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill', 'TodoWrite', 'ToolSearch'];

/** Belt and braces next to the allowlist. */
export const RESTRICTED_DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'NotebookEdit', 'Task', 'Agent', 'Monitor', 'Workflow', 'PowerShell', 'REPL'];

export const GUARD_HOOK_PATH_IN_IMAGE = '/app/lib/edit-guard/guard.cjs';

/** Layer 2 for the containerized CLI: `--settings` JSON with the PreToolUse guard hook. */
export function guardHookSettings(hookPath = GUARD_HOOK_PATH_IN_IMAGE): string {
  return JSON.stringify({
    // Flag settings outrank project settings: a project's .claude/settings.json
    // (agent-writable in a full-access turn) must not be able to switch the guard off.
    disableAllHooks: false,
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node ${hookPath}`, timeout: 30 }] }],
    },
  });
}

/** The profile as the guard hook reads it (CLAUDABLE_EDIT_PROFILE). */
export function profileEnvValue(profile: EditProfile): string {
  return JSON.stringify({ id: profile.id, label: profile.label, kinds: profile.kinds, allowPaths: profile.allowPaths ?? [], denyPaths: profile.denyPaths ?? [] });
}

export type EditCheck = { ok: true } | { ok: false; kinds: EditKind[]; message: string };

/** Direct edits (file editor, visual editor): may this change be written under this profile? */
export function checkEdit(profile: EditProfile, relPath: string, before: string | null, after: string | null): EditCheck {
  if (!isRestricted(profile)) return { ok: true };
  const kinds = classify.classifyChange(relPath, before, after);
  if (classify.isAllowed(profile, kinds, relPath)) return { ok: true };
  return {
    ok: false,
    kinds: [...kinds],
    message: `Your edit profile "${profile.label}" does not allow this change (${classify.describeKinds(kinds)} in ${relPath}).`,
  };
}

export function classifyFileChange(relPath: string, before: string | null, after: string | null): Set<EditKind> {
  return classify.classifyChange(relPath, before, after);
}

export function changeAllowed(profile: EditProfile, kinds: Set<EditKind>, relPath: string): boolean {
  return classify.isAllowed(profile, kinds, relPath);
}

export function describeKinds(kinds: Iterable<EditKind>): string {
  return classify.describeKinds(new Set(kinds));
}

/** Guard for the file-editor write routes: null when the signed-in user may edit anything. */
export async function directEditGuardFor(projectId: string, userId: string | null | undefined): Promise<((relPath: string, before: string, after: string) => string | null) | null> {
  const { profile } = await resolveEditProfile(projectId, userId);
  if (!isRestricted(profile)) return null;
  return (relPath, before, after) => {
    const r = checkEdit(profile, relPath, before, after);
    return r.ok ? null : r.message;
  };
}
