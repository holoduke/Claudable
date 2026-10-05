"use client";
import { useEffect } from 'react';

/** Close a dialog on Escape while it is open. */
export function useEscapeToClose(isOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);
}

/** Tab button classes shared by the settings dialogs: a horizontal strip below md, a vertical list from md up. */
export const SETTINGS_TAB_STRIP =
  'flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible md:overflow-y-auto p-2 md:p-3';
