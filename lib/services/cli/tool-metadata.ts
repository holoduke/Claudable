/**
 * Pure helpers that derive UI metadata (action verb, file path, summary) from
 * a tool-use block / placeholder. Extracted from claude.ts so they can be
 * unit-tested and shared across CLI adapters. No DB / network / React.
 */

export type ToolAction = 'Edited' | 'Created' | 'Read' | 'Deleted' | 'Generated' | 'Searched' | 'Executed';

export const TOOL_NAME_ACTION_MAP: Record<string, ToolAction> = {
  read: 'Read',
  read_file: 'Read',
  'read-file': 'Read',
  write: 'Created',
  write_file: 'Created',
  'write-file': 'Created',
  create_file: 'Created',
  edit: 'Edited',
  edit_file: 'Edited',
  'edit-file': 'Edited',
  update_file: 'Edited',
  apply_patch: 'Edited',
  patch_file: 'Edited',
  remove_file: 'Deleted',
  delete_file: 'Deleted',
  delete: 'Deleted',
  remove: 'Deleted',
  list_files: 'Searched',
  list: 'Searched',
  ls: 'Searched',
  glob: 'Searched',
  glob_files: 'Searched',
  search_files: 'Searched',
  grep: 'Searched',
  bash: 'Executed',
  run: 'Executed',
  run_bash: 'Executed',
  shell: 'Executed',
  todo_write: 'Generated',
  todo: 'Generated',
  plan_write: 'Generated',
};

export const normalizeAction = (value: unknown): ToolAction | undefined => {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return undefined;
  if (candidate.includes('edit') || candidate.includes('modify') || candidate.includes('update') || candidate.includes('patch')) {
    return 'Edited';
  }
  if (candidate.includes('write') || candidate.includes('create') || candidate.includes('add') || candidate.includes('append')) {
    return 'Created';
  }
  if (candidate.includes('read') || candidate.includes('open') || candidate.includes('view')) {
    return 'Read';
  }
  if (candidate.includes('delete') || candidate.includes('remove')) {
    return 'Deleted';
  }
  if (
    candidate.includes('search') ||
    candidate.includes('find') ||
    candidate.includes('list') ||
    candidate.includes('glob') ||
    candidate.includes('ls') ||
    candidate.includes('grep')
  ) {
    return 'Searched';
  }
  if (candidate.includes('generate') || candidate.includes('todo') || candidate.includes('plan')) {
    return 'Generated';
  }
  if (
    candidate.includes('execute') ||
    candidate.includes('exec') ||
    candidate.includes('run') ||
    candidate.includes('bash') ||
    candidate.includes('shell') ||
    candidate.includes('command')
  ) {
    return 'Executed';
  }
  return undefined;
};

export const inferActionFromToolName = (toolName: unknown): ToolAction | undefined => {
  if (typeof toolName !== 'string') return undefined;
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TOOL_NAME_ACTION_MAP[normalized]) {
    return TOOL_NAME_ACTION_MAP[normalized];
  }
  const suffix = normalized.split(':').pop() ?? normalized;
  if (suffix && TOOL_NAME_ACTION_MAP[suffix]) {
    return TOOL_NAME_ACTION_MAP[suffix];
  }
  return normalizeAction(normalized);
};

export const pickFirstString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = pickFirstString(entry);
      if (candidate) return candidate;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nestedKeys = ['path', 'filepath', 'filePath', 'file_path', 'target', 'value'];
    for (const key of nestedKeys) {
      if (key in obj) {
        const candidate = pickFirstString(obj[key]);
        if (candidate) return candidate;
      }
    }
  }
  return undefined;
};

export const extractPathFromInput = (input: unknown, action?: ToolAction): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const candidateKeys = [
    'filePath',
    'file_path',
    'filepath',
    'path',
    'targetPath',
    'target_path',
    'target',
    'targets',
    'fullPath',
    'full_path',
    'destination',
    'destinationPath',
    'outputPath',
    'output_path',
    'glob',
    'pattern',
    'directory',
    'dir',
    'filename',
    'name',
  ];

  for (const key of candidateKeys) {
    if (key in record) {
      const result = pickFirstString(record[key]);
      if (result) {
        return result;
      }
    }
  }

  if (Array.isArray(record.targets)) {
    for (const target of record.targets as unknown[]) {
      const candidate = pickFirstString(target);
      if (candidate) {
        return candidate;
      }
    }
  }

  if (!action || action === 'Executed') {
    const commandKeys = ['command', 'cmd', 'shellCommand', 'shell_command'];
    for (const key of commandKeys) {
      if (key in record) {
        const candidate = pickFirstString(record[key]);
        if (candidate) {
          return candidate;
        }
      }
    }
  }

  return undefined;
};

export const buildToolMetadata = (block: Record<string, unknown>): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};
  const toolName = pickFirstString(block.name) ?? (typeof block.name === 'string' ? block.name : undefined);
  const toolInput = block.input;
  const inputRecord = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : undefined;

  if (toolName) {
    metadata.toolName = toolName;
  }

  if (toolInput !== undefined) {
    metadata.toolInput = toolInput;
  }

  let action =
    normalizeAction(block.action) ??
    normalizeAction(block.operation) ??
    (inputRecord ? normalizeAction(inputRecord.action) ?? normalizeAction(inputRecord.operation) : undefined) ??
    inferActionFromToolName(toolName);

  const directPath =
    pickFirstString(block.filePath) ??
    pickFirstString(block.file_path) ??
    pickFirstString(block.targetPath) ??
    pickFirstString(block.target_path) ??
    pickFirstString(block.path);

  let filePath = directPath ?? extractPathFromInput(toolInput, action);

  if (!filePath && inputRecord) {
    filePath =
      extractPathFromInput(inputRecord, action) ??
      pickFirstString(inputRecord.filePath) ??
      pickFirstString(inputRecord.file_path);
  }

  if (!filePath && inputRecord) {
    const command =
      pickFirstString(inputRecord.command) ??
      pickFirstString(inputRecord.cmd) ??
      pickFirstString(inputRecord.shellCommand) ??
      pickFirstString(inputRecord.shell_command);
    if (command) {
      metadata.command = command;
      filePath = command;
      if (!action) {
        action = 'Executed';
      }
    }
  }

  if (filePath) {
    metadata.filePath = filePath;
  }

  if (action) {
    metadata.action = action;
  }

  const summary =
    pickFirstString(block.summary) ??
    pickFirstString(block.description) ??
    pickFirstString(block.result) ??
    pickFirstString(block.resultSummary) ??
    pickFirstString(block.result_summary) ??
    (inputRecord ? pickFirstString(inputRecord.summary) ?? pickFirstString(inputRecord.description) : undefined) ??
    pickFirstString(block.diff) ??
    pickFirstString(block.diffInfo) ??
    pickFirstString(block.diff_info);

  if (summary) {
    metadata.summary = summary;
  }

  return metadata;
};
