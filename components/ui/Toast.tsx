"use client";
import { createContext, useCallback, useContext, useState, useRef } from 'react';

type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; message: string }

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Non-blocking toasts (replaces window.alert/prompt). Auto-dismiss, top-right. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => remove(id), kind === 'error' ? 6000 : 3500);
  }, [remove]);

  const api: ToastApi = {
    toast,
    success: useCallback((m: string) => toast(m, 'success'), [toast]),
    error: useCallback((m: string) => toast(m, 'error'), [toast]),
    info: useCallback((m: string) => toast(m, 'info'), [toast]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none" aria-live="polite" aria-atomic="true">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            onClick={() => remove(t.id)}
            className={`pointer-events-auto cursor-pointer max-w-sm rounded-lg border px-3.5 py-2.5 text-sm shadow-lg flex items-start gap-2 animate-[toastin_.15s_ease-out] ${
              t.kind === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : t.kind === 'error' ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100'
            }`}
          >
            <span className="mt-0.5 shrink-0">
              {t.kind === 'success' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              ) : t.kind === 'error' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
              )}
            </span>
            <span className="break-words">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Never throws if used outside the provider — falls back to a no-op + console. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  const noop = (m: string) => { if (typeof console !== 'undefined') console.warn('[toast]', m); };
  return { toast: noop, success: noop, error: noop, info: noop };
}
