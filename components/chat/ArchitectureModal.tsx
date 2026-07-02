"use client";
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/** Shows the project's runtime architecture (from .claudable/ARCHITECTURE.md,
 *  regenerated on each preview start). Opened from the "i" toolbar button. */
export default function ArchitectureModal({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setContent(''); // avoid flashing the previous project's content on reopen
    setLoading(true);
    fetch(`${API_BASE}/api/projects/${projectId}/architecture`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setContent(j?.data?.content ?? j?.content ?? 'No architecture information is available yet.');
      })
      .catch(() => !cancelled && setContent('Could not load architecture information.'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, projectId]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Project architecture">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[82vh] overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 flex items-center justify-center rounded-lg bg-[#DE7356]/15 text-[#DE7356] text-sm font-bold">i</span>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Project architecture</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : (
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h1 className="text-lg font-bold mb-1 text-gray-900 dark:text-gray-100">{children}</h1>,
                h2: ({ children }) => <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mt-5 mb-1.5">{children}</h2>,
                p: ({ children }) => <p className="text-sm text-gray-700 dark:text-gray-300 mb-2 leading-relaxed">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1 text-sm text-gray-700 dark:text-gray-300">{children}</ul>,
                strong: ({ children }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
                a: ({ children, href }) => <a href={href} className="text-[#DE7356] break-all">{children}</a>,
                code: ({ children }) => <code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[12px] font-mono text-[#DE7356]">{children}</code>,
                blockquote: ({ children }) => <blockquote className="border-l-2 border-[#DE7356]/40 pl-3 my-3 text-sm text-gray-500 dark:text-gray-400 italic">{children}</blockquote>,
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}
