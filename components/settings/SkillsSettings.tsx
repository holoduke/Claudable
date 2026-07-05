/**
 * Skills Settings — manage per-project Agent Skills and view global (shared) skills.
 * Skills are auto-loaded by the agent (settingSources: ['project','user']).
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Skill {
  name: string;
  description: string;
  content: string;
  raw: string;
  scope: 'project' | 'global';
}

interface SkillsSettingsProps {
  projectId: string;
}

const EXAMPLE = `When asked to do X, follow these steps:
1. ...
2. ...

Reference any conventions or helper files the agent should follow.`;

function SkillCard({
  skill,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isGlobal = skill.scope === 'global';
  return (
    <div className="group rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] hover:border-gray-300 dark:hover:border-white/[0.18] hover:shadow-sm transition-all">
      <div className="flex items-start gap-3 p-3.5">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm ${
            isGlobal ? 'bg-violet-50 text-violet-600' : 'bg-[#DE7356]/10 text-[#DE7356]'
          }`}
        >
          ✦
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-50 break-words">{skill.name}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isGlobal ? 'bg-violet-100 text-violet-700' : 'bg-[#DE7356]/10 text-[#DE7356]'
              }`}
            >
              {isGlobal ? 'Global' : 'Project'}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
            {skill.description || 'No description'}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800"
            >
              {open ? 'Hide' : 'View'} instructions
            </button>
            {onEdit && (
              <button onClick={onEdit} className="text-xs font-medium text-[#DE7356] hover:text-[#c9634a]">
                Edit
              </button>
            )}
            {onDelete && (
              <button onClick={onDelete} className="text-xs font-medium text-red-500 hover:text-red-600">
                Delete
              </button>
            )}
          </div>
          {open && (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 dark:bg-white/[0.06] p-3 text-[11px] leading-relaxed text-gray-700 dark:text-gray-200">
              {skill.content || '(no body)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function SkillsSettings({ projectId }: SkillsSettingsProps) {
  const [project, setProject] = useState<Skill[]>([]);
  const [global, setGlobal] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [query, setQuery] = useState('');

  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/skills`);
      const json = await res.json();
      const data = json?.data ?? {};
      setProject(Array.isArray(data.project) ? data.project : []);
      setGlobal(Array.isArray(data.global) ? data.global : []);
    } catch (e) {
      console.error('Failed to load skills:', e);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setEditing(null);
    setName('');
    setDescription('');
    setContent('');
    setError(null);
  };
  const startNew = () => {
    resetForm();
    setEditing('__new__');
  };
  const startEdit = (s: Skill) => {
    setEditing(s.name);
    setName(s.name);
    setDescription(s.description);
    setContent(s.content);
    setError(null);
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, content }),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        setError(json?.error || 'Failed to save skill');
        return;
      }
      resetForm();
      await load();
    } catch {
      setError('Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skillName: string) => {
    if (!window.confirm(`Delete the skill "${skillName}"? This can't be undone.`)) return;
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/skills/${encodeURIComponent(skillName)}`, {
        method: 'DELETE',
      });
      if (!r.ok) {
        const msg = await r.json().then((j) => j?.error || j?.message).catch(() => null);
        setError(msg || `Failed to delete skill (${r.status})`);
        return;
      }
      if (editing === skillName) resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete skill');
    }
  };

  const filteredGlobal = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return global;
    return global.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }, [global, query]);

  return (
    <div className="space-y-6 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50">Skills</h3>

      {/* Project skills */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            Project skills
            <span className="rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
              {project.length}
            </span>
          </h4>
          {editing === null && (
            <button
              onClick={startNew}
              className="rounded-lg bg-[#DE7356] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#c9634a]"
            >
              + Add skill
            </button>
          )}
        </div>

        {/* Errors from actions taken OUTSIDE the form (e.g. a failed delete) must
            be visible too — only suppress this copy while the form shows its own. */}
        {error && editing === null && (
          <div className="flex items-start justify-between gap-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
            <span className="break-words min-w-0">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 hover:text-red-800 dark:hover:text-red-300">✕</button>
          </div>
        )}

        {editing !== null && (
          <div className="space-y-3 rounded-xl border border-[#DE7356]/30 bg-[#DE7356]/5 p-4">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-50">
              {editing === '__new__' ? 'New skill' : `Edit: ${editing}`}
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editing !== '__new__'}
              placeholder="skill-name (e.g. brand-voice)"
              className="w-full rounded-lg border border-gray-300 dark:border-white/[0.08] px-3 py-2 text-sm disabled:bg-gray-100"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description — when should the agent use this?"
              className="w-full rounded-lg border border-gray-300 dark:border-white/[0.08] px-3 py-2 text-sm"
            />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={9}
              placeholder={EXAMPLE}
              className="w-full rounded-lg border border-gray-300 dark:border-white/[0.08] px-3 py-2 font-mono text-xs"
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-[#DE7356] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#c9634a] disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save skill'}
              </button>
              <button
                onClick={resetForm}
                className="rounded-lg border border-gray-300 dark:border-white/[0.08] px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/[0.06]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {project.length === 0 && editing === null ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] p-6 text-center text-sm text-gray-400 dark:text-gray-500">
            No project skills yet. Add one to teach the agent project-specific conventions.
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1">
            {project.map((s) => (
              <SkillCard key={s.name} skill={s} onEdit={() => startEdit(s)} onDelete={() => remove(s.name)} />
            ))}
          </div>
        )}
      </section>

      {/* Global skills */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            Available globally
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
              {global.length}
            </span>
          </h4>
          {global.length > 0 && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              className="w-44 rounded-lg border border-gray-300 dark:border-white/[0.08] px-3 py-1.5 text-sm focus:w-56 transition-all"
            />
          )}
        </div>
        {isLoading ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>
        ) : filteredGlobal.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] p-6 text-center text-sm text-gray-400 dark:text-gray-500">
            {global.length === 0 ? 'No global skills installed.' : 'No skills match your search.'}
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1">
            {filteredGlobal.map((s) => (
              <SkillCard key={s.name} skill={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
