/**
 * Settings Modal Base Component
 * Provides modal wrapper for settings
 */
import React, { ReactNode } from 'react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}

export function SettingsModal({ isOpen, onClose, title, icon, children }: SettingsModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={onClose} />
      
      <div className="absolute inset-y-0 right-0 max-w-3xl w-full bg-white dark:bg-[#12100e] shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 bg-linear-to-r from-gray-50 to-gray-100 dark:from-white/4 dark:to-transparent border-b border-gray-200 dark:border-white/8 ">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {icon && (
                <div className="p-2 bg-white dark:bg-white/6 rounded-lg shadow-xs text-gray-600 dark:text-gray-300 ">
                  {icon}
                </div>
              )}
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-50 ">
                {title}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-200 dark:hover:bg-white/6 rounded-lg text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-all"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden bg-gray-50 dark:bg-[#12100e] ">
          {children}
        </div>
      </div>
    </div>
  );
}