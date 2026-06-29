/**
 * Tech-stack options offered on the new-project screen (next to the design
 * picker). Stored on the project as `templateType`, which drives BOTH how the
 * preview scaffolds the starting app AND which system prompt the agent gets.
 *
 * `kind` is the framework family used to dispatch the scaffold + prompt:
 *   nuxt    -> Nuxt 4 (Vue)         — scaffold.ts
 *   next    -> Next.js (React)      — scaffold-next.ts
 *   angular -> Angular (standalone) — scaffold-angular.ts
 */
export type StackKind = 'nuxt' | 'next' | 'angular';

export interface StackOption {
  id: string;
  name: string;
  description: string;
  kind: StackKind;
}

export const STACKS: StackOption[] = [
  { id: 'nuxt', name: 'Nuxt', kind: 'nuxt', description: 'Nuxt 4 + Nuxt UI starter — a ready multi-page app to build on.' },
  { id: 'nuxt-clean', name: 'Clean Nuxt', kind: 'nuxt', description: 'Minimal Nuxt — a blank canvas the agent fills from your prompt.' },
  { id: 'next', name: 'Next.js', kind: 'next', description: 'React + Next.js (App Router) with Tailwind — a blank canvas.' },
  { id: 'angular', name: 'Angular', kind: 'angular', description: 'Angular (standalone components) with Tailwind — a blank canvas.' },
];

export const DEFAULT_STACK = 'nuxt';

export function isValidStack(id: string): boolean {
  return STACKS.some((s) => s.id === id);
}

/** Framework family for a stored stack id (defaults to nuxt for legacy projects). */
export function stackKind(templateType: string | null | undefined): StackKind {
  return STACKS.find((s) => s.id === templateType)?.kind ?? 'nuxt';
}

/** Whether a Nuxt project's stack means "scaffold a minimal/blank app". */
export function scaffoldIsClean(templateType: string | null | undefined): boolean {
  return templateType === 'nuxt-clean';
}
