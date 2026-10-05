"use client";
import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useT } from '@/contexts/I18nContext';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface GitHubRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName?: string;
  onSuccess: () => void;
}

export default function GitHubRepoModal({ 
  isOpen, 
  onClose, 
  projectId, 
  projectName,
  onSuccess 
}: GitHubRepoModalProps) {
  const t = useT();
  // What the user typed; empty means "use the default derived from the project".
  const [repoNameInput, setRepoNameInput] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false);

  const sanitizeRepoName = useCallback((name: string): string => {
    if (!name) return '';
    
    return name
      // Convert to lowercase
      .toLowerCase()
      // Replace spaces and underscores with hyphens
      .replace(/[\s_]+/g, '-')
      // Remove invalid characters
      .replace(/[^a-z0-9.-]/g, '')
      // Remove consecutive periods and hyphens
      .replace(/[-]{2,}/g, '-')
      .replace(/[.]{2,}/g, '.')
      // Remove leading/trailing periods and hyphens
      .replace(/^[.-]+|[.-]+$/g, '')
      // Limit to 100 characters
      .substring(0, 100);
  }, []);

  // Random suffix generated once per mount (lazy initializer, not render) so the
  // displayed hint is stable and the click applies exactly it.
  const [suggestionSuffix] = useState(() => Math.random().toString(36).substring(7));
  const suggestedRepoName = sanitizeRepoName(`${projectName || 'project'}-${suggestionSuffix}`);

  const validateRepoName = (name: string): string => {
    if (!name.trim()) {
      return t('settings.modal.github.errRequired');
    }

    // GitHub repository name constraints
    if (name.length > 100) {
      return t('settings.modal.github.errTooLong');
    }

    if (name.startsWith('.') || name.startsWith('-') || name.endsWith('.') || name.endsWith('-')) {
      return t('settings.modal.github.errEdges');
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return t('settings.modal.github.errChars');
    }

    if (name.includes('..')) {
      return t('settings.modal.github.errDots');
    }

    // Reserved names
    const reservedNames = ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];
    if (reservedNames.includes(name.toLowerCase())) {
      return t('settings.modal.github.errReserved');
    }

    return '';
  };

  const checkRepoAvailability = async (name: string): Promise<string> => {
    if (!name.trim()) return '';
    
    try {
      setIsCheckingAvailability(true);
      const response = await fetch(`${API_BASE}/api/github/check-repo/${encodeURIComponent(name)}`, {
        method: 'GET'
      });
      
      if (response.status === 409) {
        return t('settings.modal.github.errExists', { name });
      } else if (response.status === 404) {
        // API endpoint not implemented yet, skip availability check
        console.warn('GitHub check-repo API not implemented yet');
        return '';
      } else if (response.status === 401) {
        return t('settings.modal.github.errNoToken');
      } else if (!response.ok) {
        // If we can't check availability, don't block the user
        console.warn('Could not check repository availability:', response.status);
        return '';
      }
      
      return '';
    } catch (error) {
      console.error('Error checking repository availability:', error); // changed warn to error
      return '';
    } finally {
      setIsCheckingAvailability(false);
    }
  };

  // While open, an empty field falls back to the sanitized project name.
  const repoName = repoNameInput || (isOpen ? sanitizeRepoName(projectName || projectId || '') : '');

  // Derived validation (validateRepoName('') already yields "required").
  // The availability API check is temporarily disabled, see checkRepoAvailability.
  const nameError = validateRepoName(repoName);

  // Reset the form when the modal closes (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setRepoNameInput('');
      setDescription('');
      setIsPrivate(false);
      setIsCheckingAvailability(false);
    }
  }

  const handleRepoNameChange = (value: string) => {
    setRepoNameInput(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (nameError) return;

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/github/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo_name: repoName.trim(),
          description: description.trim(),
          private: isPrivate
        })
      });

      if (response.ok) {
        const result = await response.json();
        onSuccess();
        onClose();
        // Show success message with repository URL
        alert(t('settings.modal.github.created', { url: result.repo_url }));
      } else {
        let errorMessage = t('settings.modal.github.errUnknown');
        
        try {
          const errorData = await response.json();
          if (errorData.detail) {
            errorMessage = errorData.detail;
          } else if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          errorMessage = await response.text() || `HTTP ${response.status}: ${response.statusText}`;
        }

        if (response.status === 404) {
          errorMessage = t('settings.modal.github.err404');
        } else if (response.status === 401) {
          errorMessage = t('settings.modal.github.err401');
        } else if (response.status === 403) {
          errorMessage = t('settings.modal.github.err403');
        }

        alert(t('settings.modal.github.createFailed', { error: errorMessage }));
      }
    } catch (error) {
      console.error('GitHub repository creation error:', error);
      alert(t('settings.modal.github.createFailedRetry'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/50">
        <div className="absolute inset-0" onClick={onClose}>
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" />
          </motion.div>
        </div>
        
        <div role="dialog" aria-modal="true" aria-labelledby="github-repo-modal-title" className="relative bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-y-auto border border-gray-200 dark:border-gray-700 ">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", duration: 0.3 }}
            data-testid="github-repo-modal"
          >
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 ">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-gray-900 text-white rounded-full flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 98 96" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fillRule="evenodd" clipRule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
                  </svg>
                </div>
                <div>
                  <h2 id="github-repo-modal-title" className="text-xl font-semibold text-gray-900 dark:text-gray-50 ">{t('settings.modal.github.title')}</h2>
                  <p className="text-sm text-gray-600 dark:text-gray-300 ">{t('settings.modal.github.subtitle')}</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 p-1"
                aria-label={t('settings.modal.close')}
                disabled={isLoading}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="p-6">
            <div className="space-y-6">
              {/* Repository Name */}
              <div>
                <label htmlFor="github-repo-name" className="block text-sm font-medium text-gray-900 dark:text-gray-50 mb-2">
                  {t('settings.modal.github.repoName')} <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    id="github-repo-name"
                    type="text"
                    value={repoName}
                    onChange={(e) => handleRepoNameChange(e.target.value)}
                    className={`w-full px-3 py-2 pr-10 border rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 focus:ring-2 focus:border-transparent ${
                      nameError 
                        ? 'border-red-500 focus:ring-red-500' 
                        : 'border-gray-300 dark:border-gray-700 focus:ring-blue-500'
                    }`}
                    placeholder="my-awesome-project"
                    required
                    disabled={isLoading}
                    maxLength={100}
                  />
                  {isCheckingAvailability && (
                    <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 "></div>
                    </div>
                  )}
                </div>
                {nameError && (
                  <p className="mt-1 text-sm text-red-600 flex items-center gap-1">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                      <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2"/>
                      <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2"/>
                    </svg>
                    {nameError}
                  </p>
                )}
                {!nameError && !isCheckingAvailability && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 ">
                    {t('settings.modal.github.inspiration')} <button type="button" className="text-gray-900 dark:text-gray-50 hover:underline" onClick={() => {
                      handleRepoNameChange(suggestedRepoName);
                    }}>
                      {suggestedRepoName}
                    </button>?
                  </p>
                )}
                {isCheckingAvailability && (
                  <p className="mt-1 text-xs text-blue-600 ">
                    {t('settings.modal.github.checking')}
                  </p>
                )}
              </div>

              {/* Description */}
              <div>
                <label htmlFor="github-repo-description" className="block text-sm font-medium text-gray-900 dark:text-gray-50 mb-2">
                  {t('settings.modal.github.description')} <span className="text-gray-500 dark:text-gray-400">{t('settings.modal.optional')}</span>
                </label>
                <input
                  id="github-repo-description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={t('settings.modal.github.descriptionPlaceholder')}
                  disabled={isLoading}
                />
              </div>

              {/* Repository Visibility */}
              <div>
                <label className="block text-sm font-medium text-gray-900 dark:text-gray-50 mb-3">
                  {t('settings.modal.github.visibility')}
                </label>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-md cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ">
                    <input
                      type="radio"
                      name="visibility"
                      checked={!isPrivate}
                      onChange={() => setIsPrivate(false)}
                      className="mt-1 text-gray-900 dark:text-gray-50 "
                      disabled={isLoading}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" stroke="currentColor" strokeWidth="2"/>
                          <path d="M7 7V5a5 5 0 0 1 10 0v2" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                        <span className="font-medium text-gray-900 dark:text-gray-50 ">{t('settings.modal.github.public')}</span>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                        {t('settings.modal.github.publicDesc')}
                      </p>
                    </div>
                  </label>
                  
                  <label className="flex items-start gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-md cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ">
                    <input
                      type="radio"
                      name="visibility"
                      checked={isPrivate}
                      onChange={() => setIsPrivate(true)}
                      className="mt-1 text-gray-900 dark:text-gray-50 "
                      disabled={isLoading}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a7 7 0 0 0-14 0v2" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                        <span className="font-medium text-gray-900 dark:text-gray-50 ">{t('settings.modal.github.private')}</span>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                        {t('settings.modal.github.privateDesc')}
                      </p>
                    </div>
                  </label>
                </div>
              </div>

            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 mt-8 pt-6 border-t border-gray-200 dark:border-gray-700 ">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                disabled={isLoading}
              >
                {t('settings.modal.cancel')}
              </button>
              <button
                type="submit"
                className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white rounded-md font-medium transition-colors flex items-center gap-2"
                disabled={isLoading || isCheckingAvailability || !repoName.trim() || !!nameError}
              >
                {isLoading && (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                )}
                {isLoading ? t('settings.modal.github.creating') : t('settings.modal.github.create')}
              </button>
            </div>
          </form>
          </motion.div>
        </div>
        </div>
      )}
    </AnimatePresence>
  );
}
