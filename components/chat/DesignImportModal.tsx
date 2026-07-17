'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { unzipSync, zipSync } from 'fflate';
import { FaFileImport, FaTimes, FaCheckCircle, FaMagic } from 'react-icons/fa';
import { shouldKeep } from '@/lib/utils/design-keep';

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

type Phase = 'idle' | 'preparing' | 'uploading' | 'done' | 'error';

interface RemoteDesignProject {
  id: string;
  name: string;
  updatedAt: string | null;
  ownerName: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

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
  // Remote Claude Design projects (only when the server has the admin opt-in).
  const [remoteProjects, setRemoteProjects] = useState<RemoteDesignProject[]>([]);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase('idle');
    setProgress(0);
    setError(null);
    setManifest(null);
    setPrompt('');
    setFileName('');
    setDragOver(false);
    setImportingId(null);
  }, []);

  // Load the remote design list once when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setRemoteLoading(true);
    fetch(`${API_BASE}/api/design-remote/projects`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.success) return;
        setRemoteEnabled(!!j.data?.enabled);
        setRemoteProjects(Array.isArray(j.data?.projects) ? j.data.projects : []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRemoteLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Import a claude.ai/design project directly (server fetches + stages it).
  const importRemote = useCallback(
    async (proj: RemoteDesignProject) => {
      setError(null);
      setImportingId(proj.id);
      setFileName(proj.name);
      setPhase('preparing');
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/design-import/remote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceProjectId: proj.id }),
        });
        const payload = await res.json().catch(() => null);
        if (res.ok && payload?.success) {
          setManifest(payload.data.manifest);
          setPrompt(payload.data.suggestedPrompt || '');
          setPhase('done');
        } else {
          setPhase('error');
          setError(payload?.error || `Import failed (${res.status})`);
        }
      } catch {
        setPhase('error');
        setError('Network error while importing the design project.');
      } finally {
        setImportingId(null);
      }
    },
    [projectId]
  );

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const upload = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        setPhase('error');
        setError('Please choose a .zip export from Claude Design.');
        return;
      }
      setFileName(file.name);
      setError(null);
      setProgress(0);
      setPhase('preparing');

      // Pre-filter the zip in the browser: keep only the design files (screens,
      // fonts, assets) and re-zip them, so we upload a few MB instead of the full
      // export (often hundreds of MB of screenshots/raw uploads that otherwise
      // time out the proxy). The server filters again as a safety net.
      let payloadZip: Uint8Array;
      try {
        await new Promise((r) => setTimeout(r, 30)); // let the 'preparing' state paint
        const raw = new Uint8Array(await file.arrayBuffer());
        const kept = unzipSync(raw, { filter: (f) => shouldKeep(f.name) });
        const hasScreens = Object.keys(kept).some((n) => n.toLowerCase().endsWith('.dc.html'));
        if (!hasScreens) {
          setPhase('error');
          setError("This doesn't look like a Claude Design export — no .dc.html screens found.");
          return;
        }
        payloadZip = zipSync(kept);
      } catch {
        setPhase('error');
        setError('Could not read the zip file.');
        return;
      }

      setPhase('uploading');
      // zipSync returns a fresh, offset-0 array, so its buffer is exactly the data.
      const blob = new Blob([payloadZip.buffer as ArrayBuffer], { type: 'application/zip' });
      const form = new FormData();
      form.append('file', blob, 'design.zip');

      // XHR gives upload progress (now of just the filtered payload).
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
    <div className="fixed inset-0 z-60 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white dark:bg-[#181310] rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-white/8">
          <div className="flex items-center gap-2.5">
            <FaFileImport className="text-gray-700 dark:text-gray-200" size={16} />
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50">Import from Claude Design</h3>
          </div>
          <button onClick={handleClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300" aria-label="Close">
            <FaTimes size={16} />
          </button>
        </div>

        <div className="p-6">
          {/* Idle / dropzone */}
          {phase === 'idle' && (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                Upload a <span className="font-medium">.zip</span> export from{' '}
                <span className="font-medium">claude.ai/design</span>. The screens, fonts and
                assets are staged into <code className="px-1 py-0.5 bg-gray-100 dark:bg-white/6 rounded-sm text-xs">design-reference/</code>,
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
                  dragOver ? 'border-brand-500 bg-brand-500/10' : 'border-gray-300 dark:border-white/8 hover:border-gray-400 bg-gray-50 dark:bg-white/3'
                }`}
              >
                <FaFileImport className="mx-auto text-gray-400 dark:text-gray-500 mb-3" size={26} />
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Drop the zip here, or click to choose</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Design-process noise (screenshots, raw uploads) is skipped automatically.</p>
              </div>
              <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onPick} />

              {/* Remote list: pick one of your Claude Design projects and import
                  it directly — the server downloads + processes it for you.
                  Only shown when the admin opt-in is configured. */}
              {remoteEnabled && (
                <div className="mt-5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="h-px flex-1 bg-gray-100 dark:bg-white/8" />
                    <span className="text-[11px] uppercase tracking-wide text-gray-400 dark:text-gray-500">or pick from your designs</span>
                    <span className="h-px flex-1 bg-gray-100 dark:bg-white/8" />
                  </div>
                  {remoteLoading ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-3 text-center">Loading your designs…</p>
                  ) : remoteProjects.length === 0 ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 py-3 text-center">No Claude Design projects found.</p>
                  ) : (
                    <div className="max-h-52 overflow-y-auto space-y-1.5 pr-0.5">
                      {remoteProjects.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => importRemote(p)}
                          disabled={importingId !== null}
                          className="w-full flex items-center gap-3 text-left rounded-lg border border-gray-200 dark:border-white/8 px-3 py-2.5 hover:border-brand-500/40 hover:bg-brand-500/3 disabled:opacity-50 transition-colors"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-50 truncate">{p.name}</p>
                            <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                              {[p.ownerName, timeAgo(p.updatedAt)].filter(Boolean).join(' · ') || 'Claude Design'}
                            </p>
                          </div>
                          <span className="text-xs text-brand-500 font-medium shrink-0">
                            {importingId === p.id ? 'Importing…' : 'Import'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Uploading */}
          {phase === 'preparing' && (
            <div className="py-8 text-center">
              <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-gray-300 dark:border-white/8 border-t-brand-500" />
              <p className="text-sm text-gray-700 dark:text-gray-200 truncate">Preparing {fileName}…</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Extracting just the design files (skipping screenshots &amp; raw uploads)</p>
            </div>
          )}

          {phase === 'uploading' && (
            <div className="py-6">
              <p className="text-sm text-gray-700 dark:text-gray-200 mb-3 truncate">Uploading {fileName}…</p>
              <div className="h-2 w-full bg-gray-100 dark:bg-white/6 rounded-full overflow-hidden">
                <div className="h-full bg-brand-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{progress}%{progress === 100 ? ' · extracting…' : ''}</p>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="py-4">
              <p className="text-sm text-red-600 mb-4">{error}</p>
              <button
                onClick={reset}
                className="h-9 px-4 bg-gray-100 dark:bg-white/6 hover:bg-gray-200 dark:hover:bg-white/6 text-gray-800 dark:text-gray-100 rounded-lg text-sm font-medium"
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
                        : 'bg-gray-50 dark:bg-white/6 border-gray-200 dark:border-white/8 text-gray-700 dark:text-gray-200'
                    }`}
                  >
                    {s}
                  </span>
                ))}
              </div>

              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
                Instruction for the AI
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={7}
                className="w-full text-sm border border-gray-200 dark:border-white/8 rounded-lg p-3 focus:outline-hidden focus:ring-2 focus:ring-brand-500 resize-y"
              />

              <div className="flex items-center justify-between gap-3 mt-4">
                <button
                  onClick={handleClose}
                  className="h-9 px-4 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 text-sm font-medium"
                >
                  Keep staged for later
                </button>
                <button
                  onClick={() => {
                    onApply(prompt);
                    handleClose();
                  }}
                  disabled={!prompt.trim()}
                  className="h-9 px-4 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-40 flex items-center gap-2"
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
