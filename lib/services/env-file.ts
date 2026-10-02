/**
 * Pure .env parsing / patching (no fs, no DB) so it can be unit-tested.
 *
 * The project's .env is shared between the Settings → Envs tab (DB-backed) and
 * whatever else writes it (the agent, an import, the user's own repo). Writes
 * from the UI therefore PATCH the file — only the keys being set or removed
 * change — instead of regenerating it from the DB, which used to delete every
 * key the DB didn't know about (DATABASE_URL, API keys, …).
 */

export const ENV_FILE_HEADER =
  '# Environment Variables\n# Managed by Project Settings; other keys in this file are kept as-is.\n';

const ASSIGNMENT_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;

export type EnvLine =
  | { kind: 'raw'; text: string }
  | { kind: 'var'; key: string; value: string; exported: boolean; text: string };

/** Unescape a double-quoted value (dotenv expands \n and \r; we also undo \" and \\ we write). */
function unescapeDouble(raw: string): string {
  return raw.replace(/\\([nr"\\])/g, (_m, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/** Index of the closing quote in `s` starting at `from`, honouring backslash escapes for `"`. */
function findClosingQuote(s: string, quote: string, from: number): number {
  for (let i = from; i < s.length; i += 1) {
    if (quote === '"' && s[i] === '\\') { i += 1; continue; }
    if (s[i] === quote) return i;
  }
  return -1;
}

function parseUnquoted(rest: string): string {
  // An inline comment needs whitespace before the '#': `URL=a#b` keeps the '#'.
  const commentAt = rest.search(/\s#/);
  return (commentAt >= 0 ? rest.slice(0, commentAt) : rest).trim();
}

/**
 * Split .env contents into lines/entries. Quoted values may span several
 * physical lines; such an entry keeps all of them in `text`. Unparseable lines,
 * comments and blank lines come back as `raw` so a patch writes them unchanged.
 */
export function parseEnvLines(contents: string): EnvLine[] {
  const lines = contents.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out: EnvLine[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.trim().startsWith('#') ? null : line.match(ASSIGNMENT_RE);
    if (!match) {
      out.push({ kind: 'raw', text: line });
      continue;
    }
    const [, , exportKw, key, restRaw] = match;
    const rest = restRaw.trimStart();
    const quote = rest[0];

    if (quote === '"' || quote === "'" || quote === '`') {
      // Look for the closing quote, possibly on a later line (multiline value).
      let body = rest.slice(1);
      let end = findClosingQuote(body, quote, 0);
      let j = i;
      while (end < 0 && j + 1 < lines.length) {
        j += 1;
        body += `\n${lines[j]}`;
        end = findClosingQuote(body, quote, 0);
      }
      if (end >= 0) {
        const inner = body.slice(0, end);
        out.push({
          kind: 'var',
          key,
          value: quote === '"' ? unescapeDouble(inner) : inner,
          exported: Boolean(exportKw),
          text: lines.slice(i, j + 1).join('\n'),
        });
        i = j;
        continue;
      }
      // Unterminated quote: treat the single line as an unquoted value.
    }

    out.push({ kind: 'var', key, value: parseUnquoted(rest), exported: Boolean(exportKw), text: line });
  }
  return out;
}

/** Parse .env contents into a key→value map (last occurrence wins, like dotenv). */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of parseEnvLines(contents)) {
    if (line.kind === 'var') result[line.key] = line.value;
  }
  return result;
}

/** Serialize a value so dotenv (and parseEnvLines) reads it back unchanged. */
export function serializeEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@%+,=?&~^-]+$/.test(value)) return value;
  // Single quotes are literal in dotenv: no escapes, no ${} expansion.
  if (!value.includes("'") && !/[\r\n]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

export function formatEnvLine(key: string, value: string, exported = false): string {
  return `${exported ? 'export ' : ''}${key}=${serializeEnvValue(value)}`;
}

export interface EnvPatch {
  /** Keys to add or overwrite (these values win over what the file has). */
  set?: Record<string, string>;
  /** Keys to drop from the file. */
  remove?: readonly string[];
}

/**
 * Apply a patch to .env contents. Keys not mentioned are left byte-for-byte
 * (including comments, blank lines and their order). A set key replaces its
 * first occurrence in place (later duplicates are dropped so the new value
 * wins); new keys are appended. Returns the new contents.
 */
export function patchEnvContents(contents: string, patch: EnvPatch): string {
  const set = patch.set ?? {};
  const remove = new Set(patch.remove ?? []);
  const written = new Set<string>();
  const isEmptyFile = contents.trim() === '';

  const kept = parseEnvLines(contents).flatMap((line): string[] => {
    if (line.kind === 'raw') return [line.text];
    if (remove.has(line.key)) return [];
    if (Object.prototype.hasOwnProperty.call(set, line.key)) {
      if (written.has(line.key)) return [];
      written.add(line.key);
      return [formatEnvLine(line.key, set[line.key], line.exported)];
    }
    return [line.text];
  });

  const appended = Object.keys(set)
    .filter((key) => !written.has(key) && !remove.has(key))
    .map((key) => formatEnvLine(key, set[key]));

  if (isEmptyFile && appended.length === 0) return contents;
  const head = isEmptyFile ? [ENV_FILE_HEADER.trimEnd(), ''] : kept;
  const all = [...head, ...appended];
  return all.length > 0 ? `${all.join('\n')}\n` : '';
}

export interface EnvVarRecord {
  id: string;
  key: string;
  value: string;
  scope: string;
  var_type: string;
  is_secret: boolean;
  description?: string | null;
  /** 'db' = managed in Project Settings; 'file' = only present in the project's .env. */
  source?: 'db' | 'file';
}

/**
 * The Envs tab view: every DB row plus keys that exist only in the .env file
 * (written by the agent/import). File-only rows are masked by default; editing
 * one adopts it into the DB. DB rows keep their DB value — a file/DB mismatch is
 * what the conflicts endpoint reports.
 */
export function mergeEnvView(
  dbRows: readonly EnvVarRecord[],
  fileVars: Readonly<Record<string, string>>,
): EnvVarRecord[] {
  const dbKeys = new Set(dbRows.map((row) => row.key));
  const fileOnly = Object.keys(fileVars)
    .filter((key) => !dbKeys.has(key))
    .sort()
    .map((key): EnvVarRecord => ({
      id: `file:${key}`,
      key,
      value: fileVars[key],
      scope: 'runtime',
      var_type: 'string',
      is_secret: true,
      description: null,
      source: 'file',
    }));
  return [...dbRows.map((row) => ({ ...row, source: 'db' as const })), ...fileOnly];
}

/** Keys the .env format can hold safely (blocks newline/`=` injection into the file). */
export function isValidEnvKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 256 && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key);
}
