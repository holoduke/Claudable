export type ClaudeModelId =
  | 'claude-fable-5-1'
  | 'claude-fable-5'
  | 'claude-opus-5'
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001';

export interface ClaudeModelDefinition {
  id: ClaudeModelId;
  /** Human friendly display name */
  name: string;
  /** Optional longer description */
  description?: string;
  /** Whether the model can accept images */
  supportsImages?: boolean;
  /** Acceptable alias strings that should resolve to this model id */
  aliases: string[];
}

export const CLAUDE_MODEL_DEFINITIONS: ClaudeModelDefinition[] = [
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    description: 'Anthropic’s latest flagship model',
    supportsImages: true,
    aliases: [
      'claude-fable-5-1',
      'claude-fable-5.1',
      'claude-fable5.1',
      'fable-5-1',
      'fable-5.1',
      'fable5.1',
      // Generic fable aliases resolve to the newest Fable
      'claude-fable',
      'fable',
    ],
  },
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    description: 'Previous Fable flagship',
    supportsImages: true,
    aliases: [
      'claude-fable-5',
      'claude-fable-5-latest',
      'claude-fable5',
      'fable-5',
      'fable5',
    ],
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    description: 'Claude 5 family — deepest reasoning',
    supportsImages: true,
    aliases: [
      'claude-opus-5',
      'claude-opus-5-latest',
      'claude-opus5',
      'opus-5',
      'opus5',
      // Generic opus aliases resolve to the newest Opus
      'claude-opus',
      'opus',
    ],
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    description: 'Claude 5 family — fast and highly capable',
    supportsImages: true,
    aliases: [
      'claude-sonnet-5',
      'claude-sonnet-5-latest',
      'claude-sonnet5',
      'sonnet-5',
      'sonnet5',
      // Generic sonnet aliases resolve to the newest Sonnet
      'claude-sonnet',
      'sonnet',
    ],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    description: 'The most intelligent Claude 4 model for building agents and coding',
    supportsImages: true,
    aliases: [
      'claude-opus-4-8',
      'claude-opus-4.8',
      'opus-4-8',
      'opus-4.8',
      'claude-opus-4',
      'opus-4',
    ],
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Previous-generation Opus',
    supportsImages: true,
    aliases: [
      'claude-opus-4-6',
      'claude-opus-4.6',
      'opus-4-6',
      'opus-4.6',
      // Legacy aliases
      'claude-opus-4-5-20251101',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1-20250805',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-3-opus',
      'claude-3-opus-20240229',
      'claude-3-opus-latest',
    ],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'The best combination of speed and intelligence',
    supportsImages: true,
    aliases: [
      'claude-sonnet-4-6',
      'claude-sonnet-4.6',
      'claude-sonnet-4',
      'sonnet-4-6',
      'sonnet-4.6',
      'sonnet-4',
      // Legacy aliases
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-3.5-sonnet',
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-latest',
      'claude-3-7-sonnet-20250219',
      'claude-3-7-sonnet',
      'claude-3.7-sonnet',
    ],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'The fastest model with near-frontier intelligence',
    supportsImages: true,
    aliases: [
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
      'claude-haiku-4.5',
      'claude-haiku-4',
      'claude-haiku',
      'haiku-4-5-20251001',
      'haiku-4-5',
      'haiku-4.5',
      'haiku-4',
      'haiku',
      'claude-3-haiku',
      'claude-3-haiku-20240307',
      'claude-3-haiku-latest',
      'claude-haiku-3.5',
    ],
  },
];

// Default agent model. On Opus 4.8 for now (Fable 5 is out of credits).
export const CLAUDE_DEFAULT_MODEL: ClaudeModelId = 'claude-opus-4-8';

const CLAUDE_MODEL_ALIAS_MAP: Record<string, ClaudeModelId> = CLAUDE_MODEL_DEFINITIONS.reduce(
  (map, definition) => {
    definition.aliases.forEach(alias => {
      const key = alias.trim().toLowerCase().replace(/[\s_]+/g, '-');
      map[key] = definition.id;
    });
    map[definition.id.toLowerCase()] = definition.id;
    return map;
  },
  {} as Record<string, ClaudeModelId>
);

export function normalizeClaudeModelId(model?: string | null): ClaudeModelId {
  if (!model) return CLAUDE_DEFAULT_MODEL;
  const normalized = model.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const resolved = CLAUDE_MODEL_ALIAS_MAP[normalized];
  if (!resolved) {
    // An unrecognized id silently falls back to the DEFAULT (the flagship / most
    // expensive) model — a stale client value or typo would then bill the user
    // for Opus. Surface it so it's diagnosable rather than a silent upgrade.
    console.warn(`[claudeModels] Unknown model "${model}" → falling back to ${CLAUDE_DEFAULT_MODEL}`);
    return CLAUDE_DEFAULT_MODEL;
  }
  return resolved;
}

function getClaudeModelDefinition(id: string): ClaudeModelDefinition | undefined {
  return (
    CLAUDE_MODEL_DEFINITIONS.find(def => def.id === id) ??
    CLAUDE_MODEL_DEFINITIONS.find(def =>
      def.aliases.some(alias => alias.toLowerCase() === id.toLowerCase())
    )
  );
}

export function getClaudeModelDisplayName(id: string): string {
  return getClaudeModelDefinition(id)?.name ?? id;
}
