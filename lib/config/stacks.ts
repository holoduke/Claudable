/**
 * Tech-stack options offered on the new-project screen (next to the design
 * picker). Stored on the project as `templateType`, which drives how the preview
 * scaffolds the starting app.
 *
 * Today both options are Nuxt-based (a full starter vs a clean blank canvas).
 * Adding a genuinely different framework (e.g. Next.js) means a stack-specific
 * scaffold + system prompt + preview command — wire those, then add it here.
 */
export interface StackOption {
  id: string;
  name: string;
  description: string;
}

export const STACKS: StackOption[] = [
  { id: 'nuxt', name: 'Nuxt', description: 'Nuxt 4 + Nuxt UI starter — a ready multi-page app to build on.' },
  { id: 'nuxt-clean', name: 'Clean start', description: 'Minimal Nuxt — a blank canvas the agent fills from your prompt.' },
];

export const DEFAULT_STACK = 'nuxt';

export function isValidStack(id: string): boolean {
  return STACKS.some((s) => s.id === id);
}

/** Whether a project's stored stack means "scaffold a minimal/blank app". */
export function scaffoldIsClean(templateType: string | null | undefined): boolean {
  return templateType === 'nuxt-clean';
}
