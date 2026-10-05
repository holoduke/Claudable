/**
 * Vercel Project Connection Modal
 * Create and connect a Vercel project to the existing GitHub repository
 */
import React, { useState } from 'react';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface VercelProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  onSuccess: () => void;
}

export default function VercelProjectModal({ 
  isOpen, 
  onClose, 
  projectId, 
  projectName,
  onSuccess 
}: VercelProjectModalProps) {
  const t = useT();
  const [vercelProjectName, setVercelProjectName] = useState('');
  const [framework, setFramework] = useState('nextjs');
  const [teamId, setTeamId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);

  // Set the name and, when it actually changes, refresh the availability hint.
  // The real availability check is temporarily disabled to avoid API issues:
  // any non-empty name counts as available.
  const applyProjectName = (name: string) => {
    setVercelProjectName(name);
    if (name === vercelProjectName) return;
    if (name.trim()) {
      setIsAvailable(true);
      setError('');
    } else {
      setIsAvailable(null);
    }
  };

  // Initialize with project name when modal opens (adjusted during render).
  const [initFor, setInitFor] = useState<{ isOpen: boolean; projectName: string } | null>(null);
  if (!initFor || initFor.isOpen !== isOpen || initFor.projectName !== projectName) {
    setInitFor({ isOpen, projectName });
    if (isOpen && projectName) {
      applyProjectName(projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
    }
  }

  // Check project name availability
  const checkAvailability = async (name: string) => {
    if (!name.trim()) {
      setIsAvailable(null);
      return;
    }

    setCheckingAvailability(true);
    try {
      const response = await fetch(`${API_BASE}/api/vercel/check-project/${encodeURIComponent(name)}`);
      
      if (response.ok) {
        setIsAvailable(true);
        setError('');
      } else {
        try {
          const errorData = await response.json();
          setIsAvailable(false);
          if (response.status === 401) {
            setError(t('settings.modal.vercel.errToken'));
          } else if (response.status === 409) {
            setError(t('settings.modal.vercel.errExists'));
          } else {
            setError(errorData.detail || t('settings.modal.vercel.errUnavailable'));
          }
        } catch {
          setIsAvailable(false);
          setError(t('settings.modal.vercel.errUnavailable'));
        }
      }
    } catch (err) {
      console.error('Error checking Vercel project availability:', err);
      setError(t('settings.modal.vercel.errCheck'));
      setIsAvailable(null);
    } finally {
      setCheckingAvailability(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vercelProjectName.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_name: vercelProjectName.trim(),
          framework: framework,
          team_id: teamId.trim() || undefined
        }),
      });

      if (response.ok) {
        const result = await response.json();
        onSuccess();
        onClose();
        alert(t('settings.modal.vercel.success', { message: result.message }));
      } else {
        try {
          const errorData = await response.json();
          if (response.status === 400) {
            setError(errorData.detail || t('settings.modal.vercel.errNeedsRepo'));
          } else if (response.status === 401) {
            setError(t('settings.modal.vercel.errToken'));
          } else {
            setError(errorData.detail || t('settings.modal.vercel.errConnect'));
          }
        } catch {
          setError(t('settings.modal.vercel.errConnect'));
        }
      }
    } catch (err) {
      console.error('Error connecting Vercel:', err);
      setError(t('settings.modal.vercel.errNetwork'));
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setVercelProjectName('');
    setFramework('nextjs');
    setTeamId('');
    setError('');
    setIsAvailable(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div role="dialog" aria-modal="true" aria-labelledby="vercel-modal-title" className="bg-white dark:bg-gray-900 rounded-lg p-6 w-full max-w-md mx-4 max-h-[90dvh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 id="vercel-modal-title" className="text-xl font-semibold text-gray-900 dark:text-gray-50 ">
            {t('settings.modal.vercel.title')}
          </h2>
          <button
            onClick={handleClose}
            aria-label={t('settings.modal.close')}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 "
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mb-4 p-3 bg-blue-50 rounded-lg">
          <p className="text-sm text-blue-700 ">
            {t('settings.modal.vercel.intro')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="vercel-project-name" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              {t('settings.modal.vercel.projectName')}
            </label>
            <input
              id="vercel-project-name"
              type="text"
              value={vercelProjectName}
              onChange={(e) => applyProjectName(e.target.value)}
              placeholder="my-awesome-project"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 "
              required
              disabled={isLoading}
            />
            {isAvailable === true && vercelProjectName.trim() && (
              <p className="text-sm text-green-600 mt-1">✓ {t('settings.modal.vercel.ready')}</p>
            )}
          </div>

          <div>
            <label htmlFor="vercel-framework" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              {t('settings.modal.vercel.framework')}
            </label>
            <select
              id="vercel-framework"
              value={framework}
              onChange={(e) => setFramework(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 "
              disabled={isLoading}
            >
              <option value="nextjs">Next.js</option>
              <option value="react">React</option>
              <option value="vue">Vue.js</option>
              <option value="nuxtjs">Nuxt.js</option>
              <option value="svelte">Svelte</option>
              <option value="angular">Angular</option>
              <option value="static">{t('settings.modal.vercel.staticHtml')}</option>
              <option value="other">{t('settings.modal.vercel.other')}</option>
            </select>
          </div>

          <div>
            <label htmlFor="vercel-team-id" className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              {t('settings.modal.vercel.teamId')}
            </label>
            <input
              id="vercel-team-id"
              type="text"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              placeholder="team_xxxxxxxxx"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 "
              disabled={isLoading}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('settings.modal.vercel.teamIdHint')}
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-600 ">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-4 py-2 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              disabled={isLoading}
            >
              {t('settings.modal.cancel')}
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-black text-white rounded-md hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              disabled={isLoading || !vercelProjectName.trim()}
            >
              {isLoading ? t('settings.modal.vercel.connecting') : t('settings.modal.vercel.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
