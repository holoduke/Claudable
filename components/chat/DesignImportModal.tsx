'use client';

import { useCallback, useRef, useState } from 'react';
import { FaFileImport, FaTimes, FaCheckCircle, FaMagic } from 'react-icons/fa';

interface DesignImportManifest {
  dir: string;
  screens: string[];
  designSystemPresent: boolean;
  assetCount: number;
  fontCount: number;
  fileCount: number;
  totalBytes: number;
  skippedNoise: number;
}

interface DesignImportModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Called when the user chooses to send the port instruction to the agent. */
  onApply: (prompt: string) => void;
}

type Phase = 'idle' | 'uploading' | 'done' | 'error';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export default function DesignImportModal({
  projectId,
  isOpen,
  onClose,
  onApply,
}: DesignImportModalProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<DesignImportManifest | null>(null);
  const [prompt, setPrompt] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setPhase('idle');
    setProgress(0);
    setError(null);
    setManifest(null);
    setPrompt('');
    setFileName('');
    setDragOver(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const upload = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        setPhase('error');
        setError('Please choose a .zip export from Claude Design.');
        return;
      }
      setFileName(file.name);
      setPhase('uploading');
      setProgress(0);
      setError(null);

      const form = new FormData();
      form.append('file', file);

      // XHR gives upload progress, which matters for large design exports.
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/projects/${projectId}/design-import`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let payload: any = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload?.success) {
          setManifest(payload.data.manifest);
          setPrompt(payload.data.suggestedPrompt || '');
          setPhase('done');
        } else {
          setPhase('error');
          setError(payload?.error || `Upload failed (${xhr.status})`);
        }
      };
      xhr.onerror = () => {
        setPhase('error');
        setError('Network error during upload.');
      };
      xhr.send(form);
    },
    [projectId]
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) upload(f);
      if (inputRef.current) inputRef.current.value = '';
    },
    [upload]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) upload(f);
    },
    [upload]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <FaFileImport className="text-gray-700" size={16} />
            <h3 className="text-base font-semibold text-gray-900">Import from Claude Design</h3>
          </div>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <FaTimes size={16} />
          </button>
        </div>

        <div className="p-6">
          {/* Idle / dropzone */}
          {phase === 'idle' && (
            <>
              <p className="text-sm text-gray-600 mb-4">
                Upload a <span className="font-medium">.zip</span> export from{' '}
                <span className="font-medium">claude.ai/design</span>. The screens, fonts and
                assets are staged into <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">design-reference/</code>,
                then the AI ports them into this app — keeping your current framework and structure.
              </p>
              <div
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                  dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50'
                }`}
              >
                <FaFileImport className="mx-auto text-gray-400 mb-3" size={26} />
                <p className="text-sm font-medium text-gray-700">Drop the zip here, or click to choose</p>
                <p className="text-xs text-gray-400 mt-1">Design-process noise (screenshots, raw uploads) is skipped automatically.</p>
              </div>
              <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onPick} />
            </>
          )}

          {/* Uploading */}
          {phase === 'uploading' && (
            <div className="py-6">
              <p className="text-sm text-gray-700 mb-3 truncate">Uploading {fileName}…</p>
              <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs text-gray-400 mt-2">{progress}%{progress === 100 ? ' · extracting…' : ''}</p>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="py-4">
              <p className="text-sm text-red-600 mb-4">{error}</p>
              <button
                onClick={reset}
                className="h-9 px-4 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg text-sm font-medium"
              >
                Try again
              </button>
            </div>
          )}

          {/* Done */}
          {phase === 'done' && manifest && (
            <div>
              <div className="flex items-center gap-2 text-emerald-600 mb-3">
                <FaCheckCircle size={15} />
                <span className="text-sm font-medium">
                  Staged {manifest.screens.length} screen{manifest.screens.length === 1 ? '' : 's'} ·{' '}
                  {manifest.assetCount} assets · {manifest.fontCount} fonts
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 mb-4 max-h-24 overflow-y-auto">
                {manifest.screens.map((s) => (
                  <span
                    key={s}
                    className={`text-xs px-2 py-1 rounded-md border ${
                      /design\s*system/i.test(s)
                        ? 'bg-amber-50 border-amber-200 text-amber-800 font-medium'
                        : 'bg-gray-50 border-gray-200 text-gray-700'
                    }`}
                  >
                    {s}
                  </span>
                ))}
              </div>

              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                Instruction for the AI
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={7}
                className="w-full text-sm border border-gray-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-200 resize-y"
              />

              <div className="flex items-center justify-between gap-3 mt-4">
                <button
                  onClick={handleClose}
                  className="h-9 px-4 text-gray-600 hover:text-gray-900 text-sm font-medium"
                >
                  Keep staged for later
                </button>
                <button
                  onClick={() => {
                    onApply(prompt);
                    handleClose();
                  }}
                  disabled={!prompt.trim()}
                  className="h-9 px-4 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-900 disabled:opacity-40 flex items-center gap-2"
                >
                  <FaMagic size={13} />
                  Send to AI
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
