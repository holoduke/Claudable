'use strict';
/**
 * Edit-profile guard: decides whether ONE file-editing tool call is allowed under
 * the active edit profile. Used two ways:
 *   - as a Claude Code PreToolUse command hook inside the agent container:
 *       node /app/lib/edit-guard/guard.cjs   (stdin = hook input JSON)
 *     profile from CLAUDABLE_EDIT_PROFILE (JSON), project root CLAUDABLE_EDIT_ROOT.
 *   - in-process (SDK hook callback) via evaluateEdit().
 *
 * Fail closed: an unreadable profile, a path outside the project, or an edit we
 * cannot reconstruct is denied. The post-turn diff (edit-profiles.ts) is the
 * backstop for anything that writes files without these tools.
 */
const fs = require('fs');
const path = require('path');
const { classifyChange, isAllowed, describeKinds, KIND_LABELS } = require('./classify.cjs');

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Nearest existing ancestor realpath'd, so a symlink cannot smuggle the target out. */
function realResolve(abs) {
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

function replaceOnce(text, oldStr, newStr, all) {
  if (oldStr === '') return null;
  if (all) return text.split(oldStr).join(newStr);
  const i = text.indexOf(oldStr);
  if (i < 0) return null;
  return text.slice(0, i) + newStr + text.slice(i + oldStr.length);
}

/** The file content AFTER the tool call, or undefined when it cannot be derived. */
function contentAfter(toolName, input, before) {
  if (toolName === 'Write') return typeof input.content === 'string' ? input.content : undefined;
  if (toolName === 'Edit') {
    if (before === null) return input.old_string === '' && typeof input.new_string === 'string' ? input.new_string : undefined;
    const r = replaceOnce(before, String(input.old_string ?? ''), String(input.new_string ?? ''), Boolean(input.replace_all));
    return r === null ? before : r; // no match: the tool itself fails, nothing changes
  }
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(input.edits)) return undefined;
    let text = before;
    for (const e of input.edits) {
      if (text === null) {
        if (e && e.old_string === '' && typeof e.new_string === 'string') { text = e.new_string; continue; }
        return undefined;
      }
      const r = replaceOnce(text, String(e?.old_string ?? ''), String(e?.new_string ?? ''), Boolean(e?.replace_all));
      if (r === null) return before; // the whole MultiEdit fails atomically
      text = r;
    }
    return text;
  }
  return undefined;
}

function allowedLabel(profile) {
  return (profile.kinds || []).map((k) => KIND_LABELS[k] || k).join(', ') || 'nothing';
}

/**
 * Returns null when allowed, else a denial reason written for the MODEL (it
 * relays it to the user). `readFile(abs)` returns the text or null if missing.
 */
function evaluateEdit({ profile, root, toolName, toolInput, readFile }) {
  if (!EDIT_TOOLS.has(toolName)) return null;
  if (!profile || !Array.isArray(profile.kinds)) return 'Edit profile could not be read; file edits are blocked for safety.';
  if ((profile.kinds || []).includes('code') && !(profile.allowPaths || []).length && !(profile.denyPaths || []).length) return null;
  const name = profile.label || profile.id;
  const guidance = `Do not try to work around this (other tools, other files, shell). Explain to the user, in their language, that their edit profile "${name}" only allows: ${allowedLabel(profile)}, and that someone with full edit rights must make this change.`;
  if (toolName === 'NotebookEdit') return `Blocked by the project's edit profile "${name}": notebooks cannot be edited. ${guidance}`;
  const raw = String(toolInput.file_path || '');
  if (!raw) return `Blocked by the project's edit profile "${name}": no file path. ${guidance}`;
  const realRoot = realResolve(path.resolve(root));
  const abs = realResolve(path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw));
  if (!isInside(abs, realRoot)) return `Blocked by the project's edit profile "${name}": only files inside the project can be edited. ${guidance}`;
  const rel = path.relative(realRoot, abs).split(path.sep).join('/');
  let before;
  try {
    before = readFile(abs);
  } catch {
    return `Blocked by the project's edit profile "${name}": ${rel} could not be read to check the change. ${guidance}`;
  }
  const after = contentAfter(toolName, toolInput, before);
  if (after === undefined) return `Blocked by the project's edit profile "${name}": the change to ${rel} could not be checked. ${guidance}`;
  const kinds = classifyChange(rel, before, after);
  if (isAllowed(profile, kinds, rel)) return null;
  return `Blocked by the project's edit profile "${name}": this edit to ${rel} changes ${describeKinds(kinds)}. ${guidance}`;
}

function readTextOrNull(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

function denyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let reason;
    try {
      const input = JSON.parse(raw || '{}');
      let profile = null;
      try { profile = JSON.parse(process.env.CLAUDABLE_EDIT_PROFILE || 'null'); } catch { profile = null; }
      const root = process.env.CLAUDABLE_EDIT_ROOT || input.cwd || process.cwd();
      reason = evaluateEdit({ profile, root, toolName: input.tool_name, toolInput: input.tool_input || {}, readFile: readTextOrNull });
    } catch (e) {
      reason = `Edit guard failed (${e && e.message ? e.message : 'unknown error'}); the edit is blocked for safety.`;
    }
    if (reason) process.stdout.write(denyOutput(reason));
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { evaluateEdit, contentAfter, readTextOrNull, EDIT_TOOLS };
