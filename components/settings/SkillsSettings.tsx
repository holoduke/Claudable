/**
 * Skills Settings — manage per-project Agent Skills and view global (shared) skills.
 * Skills are auto-loaded by the agent (settingSources: ['project','user']).
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiErrorMessage, responseErrorMessage } from '@/lib/client/api-error';
import { useT } from '@/contexts/I18nContext';

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

function SkillCard({
  skill,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const isGlobal = skill.scope === 'global';
  return (
    <div className="group rounded-xl border border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 hover:border-gray-300 dark:hover:border-white/18 hover:shadow-xs transition-all">
      <div className="flex items-start gap-3 p-3.5">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm ${
            isGlobal ? 'bg-violet-50 text-violet-600' : 'bg-brand-500/10 text-brand-500'
          }`}
        >
          ✦
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-50 wrap-break-word">{skill.name}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isGlobal ? 'bg-violet-100 text-violet-700' : 'bg-brand-500/10 text-brand-500'
              }`}
            >
              {isGlobal ? t('settings.skills.global') : t('settings.skills.project')}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
            {skill.description || t('settings.skills.noDescription')}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800"
            >
              {open ? t('settings.skills.hideInstructions') : t('settings.skills.viewInstructions')}
            </button>
            {onEdit && (
              <button onClick={onEdit} className="text-xs font-medium text-brand-500 hover:text-brand-600">
                {t('common.edit')}
              </button>
            )}
            {onDelete && (
              <button onClick={onDelete} className="text-xs font-medium text-red-500 hover:text-red-600">
                {t('common.delete')}
              </button>
            )}
          </div>
          {open && (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 dark:bg-white/6 p-3 text-[11px] leading-relaxed text-gray-700 dark:text-gray-200">
              {skill.content || t('settings.skills.noBody')}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function SkillsSettings({ projectId }: SkillsSettingsProps) {
  const t = useT();
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
      if (!res.ok || json?.success === false) setError(apiErrorMessage(json, t('settings.skills.loadFailed')));
    } catch {
      setError(t('settings.skills.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, t]);

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
      setError(t('settings.skills.nameRequired'));
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
        setError(apiErrorMessage(json, t('settings.skills.saveFailed')));
        return;
      }
      resetForm();
      await load();
    } catch {
      setError(t('settings.skills.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skillName: string) => {
    if (!window.confirm(t('settings.skills.confirmDelete', { name: skillName }))) return;
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/skills/${encodeURIComponent(skillName)}`, {
        method: 'DELETE',
      });
      if (!r.ok) {
        setError(await responseErrorMessage(r, t('settings.skills.deleteFailedStatus', { status: r.status })));
        return;
      }
      if (editing === skillName) resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.skills.deleteFailed'));
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
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50">{t('settings.skills.title')}</h3>

      {/* Project skills */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {t('settings.skills.projectSkills')}
            <span className="rounded-full bg-gray-100 dark:bg-white/6 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
              {project.length}
            </span>
          </h4>
          {editing === null && (
            <button
              onClick={startNew}
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600"
            >
              {t('settings.skills.add')}
            </button>
          )}
        </div>

        {/* Errors from actions taken OUTSIDE the form (e.g. a failed delete) must
            be visible too — only suppress this copy while the form shows its own. */}
        {error && editing === null && (
          <div role="alert" className="flex items-start justify-between gap-3 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
            <span className="wrap-break-word min-w-0">{error}</span>
            <button onClick={() => setError(null)} aria-label={t('settings.skills.dismissError')} className="shrink-0 hover:text-red-800 dark:hover:text-red-300">✕</button>
          </div>
        )}

        {editing !== null && (
          <div className="space-y-3 rounded-xl border border-brand-500/30 bg-brand-500/5 p-4">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-50">
              {editing === '__new__' ? t('settings.skills.newSkill') : t('settings.skills.editNamed', { name: editing })}
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editing !== '__new__'}
              placeholder={t('settings.skills.namePlaceholder')}
              aria-label={t('settings.skills.nameLabel')}
              className="w-full rounded-lg border border-gray-300 dark:border-white/8 px-3 py-2 text-sm disabled:bg-gray-100"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.skills.descriptionPlaceholder')}
              aria-label={t('settings.skills.descriptionLabel')}
              className="w-full rounded-lg border border-gray-300 dark:border-white/8 px-3 py-2 text-sm"
            />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={9}
              placeholder={t('settings.skills.contentPlaceholder')}
              aria-label={t('settings.skills.contentLabel')}
              className="w-full rounded-lg border border-gray-300 dark:border-white/8 px-3 py-2 font-mono text-xs"
            />
            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? t('common.saving') : t('settings.skills.save')}
              </button>
              <button
                onClick={resetForm}
                className="rounded-lg border border-gray-300 dark:border-white/8 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {project.length === 0 && editing === null ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-white/8 p-6 text-center text-sm text-gray-400 dark:text-gray-500">
            {t('settings.skills.emptyProject')}
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
            {t('settings.skills.availableGlobally')}
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
              {global.length}
            </span>
          </h4>
          {global.length > 0 && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.skills.search')}
              aria-label={t('settings.skills.search')}
              className="w-44 rounded-lg border border-gray-300 dark:border-white/8 px-3 py-1.5 text-sm focus:w-56 transition-all"
            />
          )}
        </div>
        {isLoading ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</p>
        ) : filteredGlobal.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-white/8 p-6 text-center text-sm text-gray-400 dark:text-gray-500">
            {global.length === 0 ? t('settings.skills.emptyGlobal') : t('settings.skills.noMatch')}
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
