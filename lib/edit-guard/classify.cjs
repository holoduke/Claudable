'use strict';
/**
 * Edit profiles: what KIND of change an edit makes (text / style / asset / code).
 *
 * Shared, dependency-free CommonJS so the SAME rules run in two places:
 *   - inside the agent container as a Claude Code PreToolUse hook (edit-guard-hook.cjs)
 *   - on the server after a turn, as the backstop diff against the pre-turn checkpoint
 *
 * Idea: tokenize a file into a "skeleton" in which every text run and every static
 * style value is replaced by a placeholder. If the skeleton changed, the edit touched
 * structure/logic (code). Otherwise the change is text and/or style, depending on which
 * placeholders' values differ. Anything we cannot reason about is code (fail closed).
 */

const KINDS = Object.freeze(['text', 'style', 'asset', 'code']);

const PROFILES = Object.freeze({
  full: Object.freeze({ id: 'full', kinds: Object.freeze(['text', 'style', 'asset', 'code']) }),
  content: Object.freeze({ id: 'content', kinds: Object.freeze(['text', 'asset']) }),
  style: Object.freeze({ id: 'style', kinds: Object.freeze(['style']) }),
  'content-style': Object.freeze({ id: 'content-style', kinds: Object.freeze(['text', 'style', 'asset']) }),
});

const T = '\u0001T';
const S = '\u0001S';
const WS = '\u0002';
/** Bigger files are not parsed (a guard hook must stay fast): any change counts as code. */
const MAX_PARSE = 8 * 1024 * 1024;

const TEXT_ATTRS = new Set(['alt', 'title', 'label', 'placeholder', 'aria-label', 'aria-description', 'description', 'href', 'src', 'srcset', 'to', 'caption', 'subtitle', 'heading', 'text']);
const STYLE_ATTRS = new Set(['class', 'classname', 'style']);
/** Tags whose URL attributes load or run something — never "just text". */
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'link', 'object', 'embed', 'base', 'frame', 'form', 'meta']);
const TEXT_KEY_RE = /^(label|title|description|text|subtitle|heading|headline|caption|alt|placeholder|content|body|tagline|excerpt|summary|message|quote|author|cta|href|to|src|image)$|(Text|Label|Title|Description|Heading|Caption|Subtitle)$/;
const STYLE_KEY_RE = /^(class|className|color)$/;
const JS_EXPR_START = new Set(['', '(', ',', '=', ':', '?', '&', '|', '>', '!', '{', '[', ';', '}', 'return', 'yield', 'await', 'default', '=>']);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav', 'pdf', 'woff', 'woff2', 'ttf', 'otf']);
const STYLE_EXT = new Set(['css', 'scss', 'sass', 'less', 'pcss', 'postcss', 'styl']);
const MARKUP_EXT = new Set(['vue', 'html', 'htm', 'svelte', 'astro']);
const JSX_EXT = new Set(['tsx', 'jsx', 'js']);
const JS_EXT = new Set(['ts', 'mjs', 'cjs', 'mts', 'cts']);
const TEXT_DOC_EXT = new Set(['md', 'markdown', 'txt']);
const CONTENT_DIRS = /(^|\/)(content|locales?|i18n|lang|messages|translations)\//;
const SERVER_DIRS = /(^|\/)(server|api|backend|prisma|drizzle|migrations|database|middleware)(\/|$)|(^|\/)middleware\.[cm]?[jt]s$|(^|\/)proxy\.[cm]?[jt]s$/;
const STYLE_CONFIG_RE = /(^|\/)(tailwind\.config|app\.config)\.[cm]?[jt]s$/;

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c);

function createSink() {
  return { skel: [], text: [], style: [] };
}

function emit(sink, kind, value) {
  if (kind === 'text') {
    sink.text.push(value.replace(/\s+/g, ' ').trim());
    sink.skel.push(T);
  } else if (kind === 'style') {
    sink.style.push(value.replace(/\s+/g, ' ').trim());
    sink.skel.push(S);
  } else {
    sink.skel.push(value);
  }
}

function skeletonOf(sink) {
  return sink.skel.join('').replace(/\u0002+/g, (m, off, s) => (isWordChar(s[off - 1]) && isWordChar(s[off + m.length]) ? ' ' : ''));
}

// ---------------------------------------------------------------- JS scanning

function endOfString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === q) return j + 1;
    else if (c === '\n') return j;
    else j += 1;
  }
  return src.length;
}

function endOfTemplate(src, i) {
  let j = i + 1;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (depth === 0 && c === '`') return j + 1;
    if (c === '$' && src[j + 1] === '{') { depth += 1; j += 2; continue; }
    if (depth > 0) {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '"' || c === "'") { j = endOfString(src, j); continue; }
      else if (c === '`') { j = endOfTemplate(src, j); continue; }
    }
    j += 1;
  }
  return src.length;
}

function endOfRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j += 1;
      while (isWordChar(src[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return j;
}

/** The object key / variable name a string literal is assigned to, if any. */
function precedingKey(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  const c = src[j];
  if (c === ':') {
    if (src[j - 1] === ':') return null;
  } else if (c === '=') {
    if (/[=!<>+\-*/%&|^?]/.test(src[j - 1] || '')) return null;
  } else {
    return null;
  }
  j -= 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (src[j] === '"' || src[j] === "'") {
    const q = src[j];
    const end = j;
    j -= 1;
    while (j >= 0 && src[j] !== q) j -= 1;
    return src.slice(j + 1, end);
  }
  const end = j + 1;
  while (j >= 0 && isWordChar(src[j])) j -= 1;
  return src.slice(j + 1, end) || null;
}

const isModuleSpecifier = (src, i) => /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*$/.test(src.slice(Math.max(0, i - 24), i));
const looksLikeLocation = (v) => /^\s*([a-z][\w+.-]*:|\/|\.\.?\/|~\/|@\/)/i.test(v);

function classifyJsString(src, i, value, sink, opts) {
  const raw = src.slice(i, i + value.length + 2);
  if (isModuleSpecifier(src, i) || value.includes('${')) return emit(sink, 'code', raw);
  if (opts.styleMode) return emit(sink, looksLikeLocation(value) ? 'code' : 'style', looksLikeLocation(value) ? raw : value);
  const key = precedingKey(src, i);
  if (key && STYLE_KEY_RE.test(key)) return emit(sink, 'style', value);
  if (key && TEXT_KEY_RE.test(key) && !/^\s*(javascript|data|vbscript):/i.test(value)) return emit(sink, 'text', value);
  return emit(sink, 'code', raw);
}

/**
 * Scan JS/TS from `i`. With `untilBrace`, stops after the `}` that closes the
 * expression we were called for and returns the index past it.
 */
function scanJs(src, i, sink, opts, untilBrace) {
  let depth = 0;
  let lastSig = '';
  while (i < src.length) {
    const c = src[i];
    if (untilBrace && c === '}' && depth === 0) return i + 1;
    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i += 1;
      sink.skel.push(WS);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = endOfString(src, i);
      classifyJsString(src, i, src.slice(i + 1, j - 1), sink, opts);
      i = j;
      lastSig = 'str';
      continue;
    }
    if (c === '`') {
      const j = endOfTemplate(src, i);
      classifyJsString(src, i, src.slice(i + 1, j - 1), sink, opts);
      i = j;
      lastSig = 'str';
      continue;
    }
    if (c === '/' && JS_EXPR_START.has(lastSig)) {
      const j = endOfRegex(src, i);
      emit(sink, 'code', src.slice(i, j));
      i = j;
      lastSig = 'regex';
      continue;
    }
    if (opts.jsx && c === '<' && JS_EXPR_START.has(lastSig) && /[A-Za-z>]/.test(src[i + 1] || '')) {
      i = scanJsxElement(src, i, sink, opts);
      lastSig = 'jsx';
      continue;
    }
    if (isWordChar(c)) {
      let j = i;
      while (j < src.length && isWordChar(src[j])) j += 1;
      const word = src.slice(i, j);
      emit(sink, opts.styleMode && /^\d/.test(word) ? 'style' : 'code', word);
      i = j;
      lastSig = word;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    emit(sink, 'code', c);
    lastSig = c === '>' && src[i - 1] === '=' ? '=>' : c;
    i += 1;
  }
  return i;
}

// ---------------------------------------------------------------- markup / JSX

function classifyAttr(sink, tag, name, value) {
  const lname = name.toLowerCase();
  if (value === undefined) return emit(sink, 'code', ` ${name}`);
  const dynamic = /\{|\$\{/.test(value);
  if (!dynamic && STYLE_ATTRS.has(lname)) {
    emit(sink, 'code', ` ${name}=`);
    return emit(sink, 'style', value);
  }
  const unsafeUrl = /^\s*(javascript|data|vbscript):/i.test(value);
  if (!dynamic && !unsafeUrl && TEXT_ATTRS.has(lname) && !DANGEROUS_TAGS.has(tag.toLowerCase())) {
    emit(sink, 'code', ` ${name}=`);
    return emit(sink, 'text', value);
  }
  return emit(sink, 'code', ` ${name}=${JSON.stringify(value)}`);
}

function readQuoted(src, i) {
  const q = src[i];
  const end = src.indexOf(q, i + 1);
  const j = end < 0 ? src.length : end;
  return { value: src.slice(i + 1, j), next: Math.min(src.length, j + 1) };
}

/** Scan a JSX element starting at `<`; returns the index past its end. */
function scanJsxElement(src, i, sink, opts) {
  i += 1;
  let j = i;
  while (j < src.length && /[\w.:-]/.test(src[j])) j += 1;
  const tag = src.slice(i, j);
  i = j;
  emit(sink, 'code', `<${tag}`);
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (i >= src.length) return i;
    if (src.startsWith('/>', i)) { emit(sink, 'code', '/>'); return i + 2; }
    if (src[i] === '>') { emit(sink, 'code', '>'); i += 1; break; }
    if (src[i] === '{') {
      emit(sink, 'code', ' {');
      i = scanJs(src, i + 1, sink, opts, true);
      emit(sink, 'code', '}');
      continue;
    }
    j = i;
    while (j < src.length && !/[\s=/>{]/.test(src[j])) j += 1;
    if (j === i) { emit(sink, 'code', src[i]); i += 1; continue; }
    const name = src.slice(i, j);
    i = j;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '=') { classifyAttr(sink, tag, name, undefined); continue; }
    i += 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === '"' || src[i] === "'") {
      const { value, next } = readQuoted(src, i);
      classifyAttr(sink, tag, name, value);
      i = next;
    } else if (src[i] === '{') {
      emit(sink, 'code', ` ${name}={`);
      i = scanJs(src, i + 1, sink, opts, true);
      emit(sink, 'code', '}');
    }
  }
  // children
  while (i < src.length) {
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i);
      const close = end < 0 ? src.length : end + 1;
      emit(sink, 'code', src.slice(i, close).replace(/\s+/g, ''));
      return close;
    }
    if (src[i] === '<') { i = scanJsxElement(src, i, sink, opts); continue; }
    if (src[i] === '{') {
      emit(sink, 'code', '{');
      i = scanJs(src, i + 1, sink, opts, true);
      emit(sink, 'code', '}');
      continue;
    }
    let k = i;
    while (k < src.length && src[k] !== '<' && src[k] !== '{') k += 1;
    emit(sink, 'text', src.slice(i, k));
    i = k;
  }
  return i;
}

function endOfBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return j + 1; }
  }
  return src.length;
}

/** Text between tags: plain runs are text, interpolations are code. */
function scanMarkupText(text, sink, flavor) {
  // {{ interpolation }} (Vue, Angular) and Angular control flow (`@if (x) {`, `}`) are code.
  const re = /\{\{[\s\S]*?\}\}|@[A-Za-z]+\b[^{}<]*\{|\}/g;
  if (flavor === 'svelte' || flavor === 'astro') {
    let i = 0;
    let start = 0;
    while (i < text.length) {
      if (text[i] === '{') {
        emit(sink, 'text', text.slice(start, i));
        const end = endOfBraces(text, i);
        emit(sink, 'code', text.slice(i, end).replace(/\s+/g, ' '));
        i = end;
        start = i;
      } else {
        i += 1;
      }
    }
    return emit(sink, 'text', text.slice(start));
  }
  let last = 0;
  for (const m of text.matchAll(re)) {
    emit(sink, 'text', text.slice(last, m.index));
    emit(sink, 'code', m[0].replace(/\s+/g, ' '));
    last = m.index + m[0].length;
  }
  return emit(sink, 'text', text.slice(last));
}

function readMarkupAttrs(src, i, sink, tag) {
  const attrs = {};
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (i >= src.length) return { i, attrs, selfClosed: false };
    if (src.startsWith('/>', i)) { emit(sink, 'code', '/>'); return { i: i + 2, attrs, selfClosed: true }; }
    if (src[i] === '>') { emit(sink, 'code', '>'); return { i: i + 1, attrs, selfClosed: false }; }
    let j = i;
    while (j < src.length && !/[\s=>]/.test(src[j]) && !src.startsWith('/>', j)) j += 1;
    if (j === i) { emit(sink, 'code', src[i]); i += 1; continue; }
    const name = src.slice(i, j);
    i = j;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '=') { classifyAttr(sink, tag, name, undefined); attrs[name.toLowerCase()] = ''; continue; }
    i += 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    let value;
    if (src[i] === '"' || src[i] === "'") {
      const r = readQuoted(src, i);
      value = r.value;
      i = r.next;
    } else {
      j = i;
      while (j < src.length && !/[\s>]/.test(src[j])) j += 1;
      value = src.slice(i, j);
      i = j;
    }
    attrs[name.toLowerCase()] = value;
    classifyAttr(sink, tag, name, value);
  }
}

function scanMarkup(src, sink, flavor) {
  let i = 0;
  if (flavor === 'astro' && /^---\r?\n/.test(src)) {
    const end = src.indexOf('\n---', 3);
    const stop = end < 0 ? src.length : end;
    emit(sink, 'code', '---');
    scanJs(src.slice(3, stop), 0, sink, { jsx: false }, false);
    i = end < 0 ? src.length : end + 4;
  }
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[i] === '<' && src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      const close = end < 0 ? src.length : end + 1;
      emit(sink, 'code', src.slice(i, close).replace(/\s+/g, ''));
      i = close;
      continue;
    }
    if (src[i] === '<' && /[A-Za-z!]/.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < src.length && /[^\s/>]/.test(src[j])) j += 1;
      const tag = src.slice(i + 1, j);
      emit(sink, 'code', `<${tag}`);
      const r = readMarkupAttrs(src, j, sink, tag);
      i = r.i;
      const lower = tag.toLowerCase();
      if (!r.selfClosed && (lower === 'script' || lower === 'style')) {
        const close = src.toLowerCase().indexOf(`</${lower}`, i);
        const body = src.slice(i, close < 0 ? src.length : close);
        if (lower === 'style') emit(sink, 'style', body);
        else scanJs(body, 0, sink, { jsx: /^(tsx|jsx)$/.test(r.attrs.lang || '') }, false);
        i = close < 0 ? src.length : close;
      }
      continue;
    }
    let k = i + 1;
    while (k < src.length && !(src[k] === '<' && /[A-Za-z!/]/.test(src[k + 1] || ''))) k += 1;
    scanMarkupText(src.slice(i, k), sink, flavor);
    i = k;
  }
}

// ---------------------------------------------------------------- files

function extOf(p) {
  const base = p.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function unsafeSvg(content) {
  return /<script|\son\w+\s*=|javascript:|<foreignObject/i.test(content || '');
}

/** How a path is judged; see the header comment. */
function fileMode(filePath) {
  const p = normalizePath(filePath);
  const ext = extOf(p);
  const segments = p.split('/');
  if (segments.some((s) => s.startsWith('.') && s !== '.' )) return 'code';
  if (IMAGE_EXT.has(ext) || ext === 'svg') return 'asset';
  if (SERVER_DIRS.test(p)) return 'code';
  if (STYLE_EXT.has(ext)) return 'style';
  if (STYLE_CONFIG_RE.test(p)) return 'style-config';
  if (/\.config\.[a-z]+$/.test(p) || /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.(json|lock)|tsconfig[^/]*\.json)$/.test(p)) return 'code';
  if (ext === 'json' && CONTENT_DIRS.test(p)) return 'text-json';
  if ((ext === 'yml' || ext === 'yaml') && CONTENT_DIRS.test(p)) return 'text-doc';
  if (TEXT_DOC_EXT.has(ext) && segments.length > 1) return 'text-doc';
  if (MARKUP_EXT.has(ext)) return 'markup';
  if (JSX_EXT.has(ext)) return 'jsx';
  if (JS_EXT.has(ext)) return 'js';
  return 'code';
}

function tokenize(mode, ext, content) {
  const sink = createSink();
  if (mode === 'markup') {
    const flavor = ext === 'vue' ? 'vue' : ext === 'svelte' ? 'svelte' : ext === 'astro' ? 'astro' : 'html';
    scanMarkup(content, sink, flavor);
  } else {
    scanJs(content, 0, sink, { jsx: mode === 'jsx', styleMode: mode === 'style-config' }, false);
  }
  return sink;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function compareTokenized(mode, ext, before, after) {
  const a = tokenize(mode, ext, before);
  const b = tokenize(mode, ext, after);
  if (skeletonOf(a) !== skeletonOf(b)) return new Set(['code']);
  const out = new Set();
  if (!sameList(a.text, b.text)) out.add('text');
  if (!sameList(a.style, b.style)) out.add(mode === 'style-config' ? 'style' : 'style');
  return out;
}

function jsonShape(v) {
  if (typeof v === 'string') return '';
  if (Array.isArray(v)) return v.map(jsonShape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonShape(x)]));
  return v;
}

function compareJson(before, after) {
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(after);
    return JSON.stringify(jsonShape(a)) === JSON.stringify(jsonShape(b)) ? new Set(['text']) : new Set(['code']);
  } catch {
    return new Set(['code']);
  }
}

/**
 * Classify one file change. `before`/`after` are file contents; null = the file
 * did not exist (creation) / no longer exists (deletion). Returns a Set of kinds.
 */
function classifyChange(filePath, before, after) {
  if (before === after) return new Set();
  if ((before && before.length > MAX_PARSE) || (after && after.length > MAX_PARSE)) return new Set(['code']);
  const mode = fileMode(filePath);
  const ext = extOf(normalizePath(filePath));
  if (mode === 'asset') {
    if (ext === 'svg' && after !== null && unsafeSvg(after)) return new Set(['code']);
    return new Set(['asset']);
  }
  if (after === null || after === undefined) return new Set(['code']);
  if (before === null || before === undefined) {
    if (mode === 'text-doc' || mode === 'text-json') return new Set(['text']);
    if (mode === 'style') return new Set(['style']);
    return new Set(['code']);
  }
  switch (mode) {
    case 'style': return new Set(['style']);
    case 'text-doc': return new Set(['text']);
    case 'text-json': return compareJson(before, after);
    case 'style-config':
    case 'markup':
    case 'jsx':
    case 'js':
      return compareTokenized(mode, ext, before, after);
    default: return new Set(['code']);
  }
}

// ---------------------------------------------------------------- profiles

function globToRegExp(glob) {
  let re = '';
  const g = normalizePath(glob);
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (g[i + 1] === '/') i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (globs, p) => (globs || []).some((g) => globToRegExp(g).test(p));

function pathAllowed(profile, filePath) {
  const p = normalizePath(filePath);
  if (matchesAny(profile.denyPaths, p)) return false;
  if (profile.allowPaths && profile.allowPaths.length > 0) return matchesAny(profile.allowPaths, p);
  return true;
}

/** May a change of these kinds to this path be made under this profile? */
function isAllowed(profile, kinds, filePath) {
  if (!profile) return false;
  if (!kinds || kinds.size === 0) return true;
  if (filePath !== undefined && !pathAllowed(profile, filePath)) return false;
  const allowed = new Set(profile.kinds || []);
  if (allowed.has('code')) return true;
  for (const k of kinds) if (!allowed.has(k)) return false;
  return true;
}

const KIND_LABELS = Object.freeze({ text: 'text', style: 'styling', asset: 'images/media', code: 'code/structure' });

function describeKinds(kinds) {
  return [...kinds].map((k) => KIND_LABELS[k] || k).join(', ');
}

module.exports = {
  KINDS,
  PROFILES,
  KIND_LABELS,
  classifyChange,
  isAllowed,
  pathAllowed,
  fileMode,
  describeKinds,
  normalizePath,
};
