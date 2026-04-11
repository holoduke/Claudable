export interface OpenCodeModelDefinition {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
}

export const OPENCODE_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-5';

export const OPENCODE_MODEL_DEFINITIONS: OpenCodeModelDefinition[] = [
  {
    id: 'anthropic/claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    description: 'Anthropic Claude via OpenCode provider routing',
  },
  {
    id: 'openai/gpt-5.4',
    name: 'GPT-5.4',
    description: 'OpenAI frontier model via OpenCode provider routing',
  },
  {
    id: 'openai/gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    description: 'OpenAI coding model via OpenCode provider routing',
  },
  {
    id: 'google/gemini-3-pro',
    name: 'Gemini 3 Pro',
    description: 'Google Gemini model via OpenCode provider routing',
  },
];

const KNOWN_IDS = new Set(OPENCODE_MODEL_DEFINITIONS.map((model) => model.id));
const PROVIDER_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;

export function normalizeOpenCodeModelId(model?: string | null): string {
  if (!model || typeof model !== 'string') {
    return OPENCODE_DEFAULT_MODEL;
  }
  const normalized = model.trim().toLowerCase();
  if (KNOWN_IDS.has(normalized) || PROVIDER_MODEL_PATTERN.test(normalized)) {
    return normalized;
  }
  return OPENCODE_DEFAULT_MODEL;
}

export function getOpenCodeModelDisplayName(id?: string | null): string {
  const normalized = normalizeOpenCodeModelId(id);
  return OPENCODE_MODEL_DEFINITIONS.find((model) => model.id === normalized)?.name ?? normalized;
}
