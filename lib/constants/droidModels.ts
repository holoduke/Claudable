export interface DroidModelDefinition {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
}

export const DROID_DEFAULT_MODEL = 'claude-sonnet-4-6';

export const DROID_MODEL_DEFINITIONS: DroidModelDefinition[] = [
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Factory Droid default Claude model',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Anthropic Opus model through Factory Droid',
  },
  {
    id: 'claude-opus-4-6-fast',
    name: 'Claude Opus 4.6 Fast',
    description: 'Faster Opus variant through Factory Droid',
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    description: 'Anthropic Opus 4.5 through Factory Droid',
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    description: 'Anthropic Sonnet 4.5 through Factory Droid',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    description: 'Anthropic Haiku 4.5 through Factory Droid',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'OpenAI frontier model through Factory Droid',
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    description: 'OpenAI coding model through Factory Droid',
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    description: 'OpenAI coding model through Factory Droid',
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    description: 'OpenAI GPT model through Factory Droid',
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    description: 'Google Gemini model through Factory Droid',
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    description: 'Google Gemini Flash model through Factory Droid',
  },
  {
    id: 'glm-4.7',
    name: 'GLM 4.7',
    description: 'Zhipu GLM model through Factory Droid',
  },
  {
    id: 'glm-5',
    name: 'GLM 5',
    description: 'Zhipu GLM model through Factory Droid',
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    description: 'Moonshot Kimi model through Factory Droid',
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax M2.5',
    description: 'MiniMax model through Factory Droid',
  },
];

const KNOWN_IDS = new Set(DROID_MODEL_DEFINITIONS.map((model) => model.id));
const CUSTOM_ALIAS_PATTERN = /^custom:[a-z0-9][a-z0-9._-]*$/;

export function isCustomDroidModelId(model?: string | null): boolean {
  if (!model || typeof model !== 'string') {
    return false;
  }
  return CUSTOM_ALIAS_PATTERN.test(model.trim().toLowerCase());
}

export function normalizeDroidModelId(model?: string | null): string {
  if (!model || typeof model !== 'string') {
    return DROID_DEFAULT_MODEL;
  }
  const normalized = model.trim().toLowerCase();
  if (KNOWN_IDS.has(normalized) || CUSTOM_ALIAS_PATTERN.test(normalized)) {
    return normalized;
  }
  return DROID_DEFAULT_MODEL;
}

export function getDroidModelDisplayName(id?: string | null): string {
  const normalized = normalizeDroidModelId(id);
  return DROID_MODEL_DEFINITIONS.find((model) => model.id === normalized)?.name ?? normalized;
}
