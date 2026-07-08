/**
 * Comment @-mentions. A mention is stored structurally ({id, name} with the
 * name snapshotted at create time) next to the comment body, which contains the
 * literal `@Name` text the composer inserted. Rendering re-finds those literals
 * to highlight them — no markup lives inside the body itself, so plain-text
 * display (exports, notifications, agents) stays readable.
 */

export interface CommentMention {
  id: string;
  name: string;
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; mention: CommentMention };

const MAX_MENTIONS = 20;
const MAX_NAME_LENGTH = 120;

/**
 * Validate an untrusted `mentions` payload into a clean, deduped list.
 * Existence/org checks against the user table are the caller's job — this
 * only enforces shape and bounds.
 */
export function sanitizeMentions(raw: unknown): CommentMention[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CommentMention[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_MENTIONS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id.trim(), name: name.trim().slice(0, MAX_NAME_LENGTH) });
  }
  return out;
}

/** Parse a comment row's mentions_json column (tolerates null/garbage). */
export function parseMentionsJson(json: string | null | undefined): CommentMention[] {
  if (!json) return [];
  try {
    return sanitizeMentions(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * Split a body into text/mention segments by re-finding each mention's literal
 * `@Name` in the text. Longer names match first so "@Anna Maria" isn't
 * shadowed by a mention named "Anna". Unmatched mentions simply don't
 * highlight; overlapping matches keep the first.
 */
export function splitBodyByMentions(body: string, mentions: CommentMention[]): MentionSegment[] {
  if (!body) return [];
  if (!mentions.length) return [{ type: 'text', text: body }];

  const byLength = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const matches: Array<{ start: number; end: number; mention: CommentMention }> = [];
  const taken: Array<[number, number]> = [];

  for (const mention of byLength) {
    const needle = `@${mention.name}`;
    let from = 0;
    while (from <= body.length - needle.length) {
      const idx = body.indexOf(needle, from);
      if (idx === -1) break;
      const end = idx + needle.length;
      const overlaps = taken.some(([s, e]) => idx < e && end > s);
      if (!overlaps) {
        matches.push({ start: idx, end, mention });
        taken.push([idx, end]);
      }
      from = idx + 1;
    }
  }

  matches.sort((a, b) => a.start - b.start);
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segments.push({ type: 'text', text: body.slice(cursor, m.start) });
    segments.push({ type: 'mention', text: body.slice(m.start, m.end), mention: m.mention });
    cursor = m.end;
  }
  if (cursor < body.length) segments.push({ type: 'text', text: body.slice(cursor) });
  return segments;
}

/**
 * Find an in-progress @-token at the caret for autocomplete: the `@` must
 * start a word, and the query runs from it to the caret (spaces allowed so
 * multi-word names keep matching while typed). Returns null when the caret
 * isn't inside one.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/[\s([{]/.test(upToCaret[at - 1])) return null; // mid-word @ (emails)
  const query = upToCaret.slice(at + 1);
  if (query.includes('@') || query.includes('\n')) return null;
  if (query.length > 60) return null;
  return { start: at, query };
}
