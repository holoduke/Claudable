// Narrow docker build context for project backends.
//
// The legacy builder uploads the WHOLE context dir on every build. A backend whose
// Dockerfile lives in a full-stack repo (context ".") then ships the frontend's
// node_modules (hundreds of MB, tens of thousands of files) through the socket
// proxy on every preview start: 6 s warm, 15+ s with a cold disk cache — for a
// build that only COPYs `backend/`.
//
// When the Dockerfile only COPY/ADDs specific, literal paths, a context holding just
// those paths (+ the Dockerfile) yields the identical image. Anything we can't prove
// (COPY ., variables, URLs, top-level globs, `..`, heredocs) → null → full context.
import path from 'path';

const SAFE_SEGMENT = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]*$/;

function joinContinuations(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!cur && /^\s*#/.test(line)) continue; // comment line (outside a continuation)
    if (line.endsWith('\\')) { cur += line.slice(0, -1) + ' '; continue; }
    out.push(cur + line);
    cur = '';
  }
  if (cur) out.push(cur);
  return out;
}

/** Normalise one COPY/ADD source to a context-relative path, or null if not provably literal. */
function literalSource(src: string): string | null {
  if (!src || /[$*?[\]{}\\]/.test(src) || /^[a-z]+:\/\//i.test(src) || src.startsWith('<<')) return null;
  const norm = path.posix.normalize(src.replace(/^\/+/, '')).replace(/\/+$/, '');
  if (!norm || norm === '.' || norm.startsWith('..') || norm.split('/').some((s) => !SAFE_SEGMENT.test(s))) return null;
  return norm;
}

/**
 * The context paths a Dockerfile can read, or null when that can't be determined
 * safely (then the caller must send the full context).
 */
export function narrowContextPaths(dockerfileText: string): string[] | null {
  const paths = new Set<string>();
  for (const line of joinContinuations(dockerfileText)) {
    const m = /^\s*(ONBUILD\s+)?(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m) continue;
    if (m[1]) return null; // ONBUILD COPY: resolved in a later build we can't see
    let rest = m[3].trim();
    if (rest.includes('<<')) return null; // heredoc
    const flags: string[] = [];
    while (rest.startsWith('--')) {
      const f = /^--\S+/.exec(rest)![0];
      flags.push(f);
      rest = rest.slice(f.length).trim();
    }
    if (flags.some((f) => /^--from=/i.test(f))) continue; // multi-stage: not the context
    if (flags.some((f) => /^--parents/i.test(f))) return null;
    let args: string[];
    if (rest.startsWith('[')) {
      try { args = JSON.parse(rest); } catch { return null; }
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return null;
    } else {
      args = rest.split(/\s+/).filter(Boolean);
    }
    if (args.length < 2) return null;
    for (const src of args.slice(0, -1)) {
      const p = literalSource(src);
      if (!p) return null;
      paths.add(p);
    }
  }
  // Drop paths already covered by a parent dir in the set (tar would add them twice).
  const sorted = [...paths].sort();
  return sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(q + '/')));
}
