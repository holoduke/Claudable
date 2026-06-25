/**
 * Skills Settings Component
 * Manage per-project Agent Skills (.claude/skills/<name>/SKILL.md).
 * Skills are auto-loaded by the agent (settingSources: ['project']).
 */
import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface Skill {
  name: string;
  description: string;
  content: string;
  raw: string;
}

interface SkillsSettingsProps {
  projectId: string;
}

const EXAMPLE = `When asked to do X, follow these steps:
1. ...
2. ...

Reference any helper files or conventions the agent should follow.`;

export function SkillsSettings({ projectId }: SkillsSettingsProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // skill name being edited, or '__new__'
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
      setSkills(Array.isArray(json?.data) ? json.data : []);
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
    } catch (e) {
      setError('Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skillName: string) => {
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/skills/${encodeURIComponent(skillName)}`, {
        method: 'DELETE',
      });
      if (editing === skillName) resetForm();
      await load();
    } catch (e) {
      console.error('Failed to delete skill:', e);
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Skills</h3>
        <p className="text-sm text-gray-500 mt-1">
          Reusable instructions the agent loads automatically for this project. Stored as{' '}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">.claude/skills/&lt;name&gt;/SKILL.md</code>.
        </p>
      </div>

      {/* List */}
      <div className="space-y-2">
        {isLoading && <p className="text-sm text-gray-400">Loading…</p>}
        {!isLoading && skills.length === 0 && (
          <p className="text-sm text-gray-400">No skills yet. Add one to extend what the agent can do.</p>
        )}
        {skills.map((s) => (
          <div
            key={s.name}
            className="flex items-start justify-between gap-3 border border-gray-200 rounded-lg px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{s.name}</div>
              <div className="text-xs text-gray-500 truncate">{s.description || 'No description'}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => startEdit(s)}
                className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Edit
              </button>
              <button
                onClick={() => remove(s.name)}
                className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Editor */}
      {editing === null ? (
        <button
          onClick={startNew}
          className="text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
        >
          + Add skill
        </button>
      ) : (
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="text-sm font-medium text-gray-900">
            {editing === '__new__' ? 'New skill' : `Edit: ${editing}`}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={editing !== '__new__'}
              placeholder="e.g. brand-voice"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 disabled:bg-gray-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Description <span className="text-gray-400">(when should the agent use this?)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use when writing marketing copy for the Salsa Shop brand."
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Instructions</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              placeholder={EXAMPLE}
              className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save skill'}
            </button>
            <button
              onClick={resetForm}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default SkillsSettings;
