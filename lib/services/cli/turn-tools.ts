/**
 * Which built-in tools an agent turn gets.
 *
 * Two independent restrictions can apply to a turn:
 *  - the requester's EDIT PROFILE (a restricted profile has no shell / sub-agents,
 *    see RESTRICTED_TOOLS in edit-profiles.ts), and
 *  - the turn's MODE: 'chat' is a read-only conversation about the project (the
 *    agent may read, search and browse but never change a file or run a command),
 *    'act' is a normal editing turn.
 *
 * They combine by INTERSECTION of the allowlists and UNION of the denylists, so a
 * combination can only ever narrow what the agent may do — never widen it.
 */
import { RESTRICTED_DISALLOWED_TOOLS, RESTRICTED_TOOLS } from '@/lib/services/edit-profiles';

export type TurnMode = 'chat' | 'act';

/** Anything other than an explicit 'chat' is an editing turn (back-compat default). */
export function parseTurnMode(value: unknown): TurnMode {
  return value === 'chat' ? 'chat' : 'act';
}

/** Read-only built-ins for a chat-mode turn (an allowlist: new CLI tools stay off). */
export const CHAT_MODE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill', 'TodoWrite', 'ToolSearch'];

/** Belt-and-braces denylist: every built-in that writes files, runs commands or spawns agents. */
export const CHAT_MODE_DISALLOWED_TOOLS: readonly string[] = [
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell', 'REPL',
  'Task', 'Agent', 'Monitor', 'Workflow', 'EnterWorktree', 'ExitWorktree',
];

export interface TurnToolPolicy {
  /** The ONLY built-in tools available (CLI --tools / SDK `tools`). */
  tools: string[];
  /** Tools removed outright (CLI --disallowedTools / SDK `disallowedTools`). */
  disallowedTools: string[];
}

/**
 * The tool policy for a turn, or null when nothing is restricted (a full-profile
 * editing turn keeps the CLI's default tool set).
 */
export function selectTurnTools(opts: { mode: TurnMode; restrictedProfile: boolean }): TurnToolPolicy | null {
  const layers: { allow: readonly string[]; deny: readonly string[] }[] = [];
  if (opts.restrictedProfile) layers.push({ allow: RESTRICTED_TOOLS, deny: RESTRICTED_DISALLOWED_TOOLS });
  if (opts.mode === 'chat') layers.push({ allow: CHAT_MODE_TOOLS, deny: CHAT_MODE_DISALLOWED_TOOLS });
  if (layers.length === 0) return null;

  const deny = new Set(layers.flatMap((l) => l.deny));
  const [first, ...rest] = layers;
  const allow = first.allow.filter((tool) => rest.every((l) => l.allow.includes(tool)) && !deny.has(tool));
  return { tools: allow, disallowedTools: [...deny] };
}

/** System-prompt note for a chat-mode turn (layer 1; the tool policy enforces it). */
export function chatModePromptNote(): string {
  return '\n\n## Chat mode (read-only)\nThe user is in CHAT mode: they want to talk about the project, not change it. ' +
    'You can read and search the code and browse the web, but you have no tools to edit files or run commands in this turn. ' +
    'Answer questions, explain, review and propose a plan. When a change is needed, describe it (with code snippets if useful) ' +
    'and tell the user to switch to Build mode to have it applied. Never claim you changed a file.';
}
