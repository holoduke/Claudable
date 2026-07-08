"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { SendHorizontal, MessageSquare, Image as ImageIcon, Wrench, Square } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface UploadedImage {
  id: string;
  filename: string;
  path: string;
  url: string;
  assetUrl?: string;
   publicUrl?: string;
}

interface ModelPickerOption {
  id: string;
  name: string;
  cli: string;
  cliName: string;
  available: boolean;
}

interface CliPickerOption {
  id: string;
  name: string;
  available: boolean;
}

interface ChatInputProps {
  onSendMessage: (message: string, images?: UploadedImage[]) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: 'act' | 'chat';
  onModeChange?: (mode: 'act' | 'chat') => void;
  projectId?: string;
  preferredCli?: string;
  selectedModel?: string;
  thinkingMode?: 'off' | 'auto' | 'forced';
  onThinkingModeChange?: (mode: 'off' | 'auto' | 'forced') => void;
  modelOptions?: ModelPickerOption[];
  onModelChange?: (option: ModelPickerOption) => void;
  modelChangeDisabled?: boolean;
  cliOptions?: CliPickerOption[];
  onCliChange?: (cliId: string) => void;
  cliChangeDisabled?: boolean;
  isRunning?: boolean;
  /** Interrupt the running turn (CLI parity: Esc). Shown as a Stop button while running. */
  onStop?: () => void;
  /** Draft handed back to the composer after an interrupt (queued text/images).
   *  ChatInput owns its text/image state, so the parent pushes it here; the nonce
   *  makes each restore apply exactly once. */
  restoreDraft?: { text: string; images?: UploadedImage[]; nonce: number } | null;
}

export default function ChatInput({
  onSendMessage,
  disabled = false,
  placeholder = "Ask Claudable...",
  mode = 'act',
  onModeChange,
  projectId,
  preferredCli = 'claude',
  selectedModel = '',
  thinkingMode = 'auto',
  onThinkingModeChange,
  modelOptions = [],
  onModelChange,
  modelChangeDisabled = false,
  cliOptions = [],
  onCliChange,
  cliChangeDisabled = false,
  isRunning = false,
  onStop,
  restoreDraft
}: ChatInputProps) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  // Live upload feedback so a large file (e.g. a zip) never looks frozen.
  const [uploadProgress, setUploadProgress] = useState<{ name: string; pct: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Skill autocomplete: typing "/" surfaces built-in commands + skills ---
  interface SkillOption { name: string; description: string; scope: string }
  const builtinCommands: SkillOption[] = useMemo(() => [
    { name: 'clear', description: 'Start a fresh conversation context (chat history is kept)', scope: 'command' },
    { name: 'compact', description: 'Summarize the conversation to free up context space', scope: 'command' },
    { name: 'usage', description: 'Show context usage, token spend and rate limits', scope: 'command' },
    { name: 'mcp', description: 'List MCP servers and their authentication status', scope: 'command' },
    { name: 'plugin', description: 'Manage plugins (marketplaces + which are enabled)', scope: 'command' },
    { name: 'help', description: 'List the available commands', scope: 'command' },
  ], []);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  // Plugin-contributed commands (/<plugin>:<command>). Prefill on select so the
  // user can add arguments; the agent expands them (the plugin is loaded via
  // --plugin-dir). scope 'plugin' → treated like a skill (prefill, not run).
  const [pluginCmds, setPluginCmds] = useState<SkillOption[]>([]);
  const [skillActiveIdx, setSkillActiveIdx] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/projects/${projectId}/skills`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.success) return;
        const all = [...(j.data?.project ?? []), ...(j.data?.global ?? [])] as any[];
        const list = all
          .filter((s) => String(s.enabled) !== 'False' && s.enabled !== false)
          .map((s) => ({ name: String(s.name), description: String(s.description ?? ''), scope: String(s.scope ?? 'project') }));
        setSkills(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/projects/${projectId}/plugins/commands`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.success || !Array.isArray(j.data)) return;
        setPluginCmds(j.data.map((c: { invocation: string; description?: string }) => ({
          name: String(c.invocation), description: String(c.description ?? ''), scope: 'plugin',
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  // The menu opens only while the whole message is a bare "/token" (a command
  // being typed) — never mid-sentence. Query = the text after the slash.
  // Allow ':' in the query so plugin commands (/<plugin>:<command>) open the menu.
  const skillQuery = /^\/[\w:-]*$/.test(message) ? message.slice(1).toLowerCase() : null;
  const skillMatches = useMemo(() => {
    if (skillQuery === null) return [];
    const commandHits = builtinCommands.filter((c) => c.name.includes(skillQuery));
    const pluginHits = pluginCmds
      .filter((c) => c.name.toLowerCase().includes(skillQuery))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(skillQuery)) - Number(a.name.toLowerCase().startsWith(skillQuery)));
    const skillHits = skills
      .filter((s) => s.name.toLowerCase().includes(skillQuery))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(skillQuery)) - Number(a.name.toLowerCase().startsWith(skillQuery)));
    // Built-in commands first — they're few and act immediately on selection+Enter.
    return [...commandHits, ...pluginHits, ...skillHits].slice(0, 12);
  }, [skills, pluginCmds, skillQuery, builtinCommands]);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const skillMenuOpen = skillQuery !== null && skillMatches.length > 0 && skillQuery !== dismissedQuery;
  useEffect(() => { setSkillActiveIdx(0); }, [skillQuery]);
  // A dismissal (Escape / running a command) only holds while the query is
  // unchanged. Without this, running "/mcp" once suppressed the menu for every
  // future "/mcp" — typing it showed nothing until Enter.
  useEffect(() => {
    if (skillQuery !== dismissedQuery && dismissedQuery !== null) setDismissedQuery(null);
  }, [skillQuery, dismissedQuery]);

  const chooseSkill = (option: SkillOption) => {
    // Built-in commands (/mcp, /usage, /help, /clear, /compact) run IMMEDIATELY on
    // selection — like the Claude CLI — instead of just filling the input (which
    // left "nothing happens" when you clicked one). Skills prefill "/name " so you
    // can add the rest of the prompt.
    if (option.scope === 'command') {
      setMessage('');
      if (skillQuery !== null) setDismissedQuery(skillQuery); // close the menu
      onSendMessage(`/${option.name}`, []);
      return;
    }
    setMessage(`/${option.name} `);
    setTimeout(() => { textareaRef.current?.focus(); adjustTextareaHeight(); }, 0);
  };

  // Position the skill menu with FIXED coords anchored to the input, so it can't
  // be clipped by the composer card. Prefer opening to the RIGHT (over the
  // preview) where there's room; fall back to above the input on narrow layouts.
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!skillMenuOpen) return;
    const place = () => {
      const el = textareaRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const W = 400, GAP = 10, M = 12;
      const roomRight = window.innerWidth - r.right;
      const maxHeight = Math.min(460, window.innerHeight - 2 * M);
      if (roomRight >= W + GAP) {
        // To the right of the input (over the preview). Clamp `top` so the menu
        // always stays fully on screen even when the input sits near the bottom.
        let top = r.top;
        if (top + maxHeight > window.innerHeight - M) top = window.innerHeight - maxHeight - M;
        if (top < M) top = M;
        setMenuStyle({ position: 'fixed', left: r.right + GAP, top, width: W, maxHeight });
      } else {
        // Narrow layout: open above the input, growing up.
        const width = Math.min(W, r.width);
        setMenuStyle({ position: 'fixed', left: r.left, bottom: window.innerHeight - r.top + GAP, width, maxHeight: Math.min(360, r.top - M) });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [skillMenuOpen, skillMatches.length]);
  const submissionLockRef = useRef(false);
  const supportsImageUpload = preferredCli !== 'cursor' && preferredCli !== 'qwen' && preferredCli !== 'glm';
  // Client-side cap mirrors the server's MAX_UPLOAD_BYTES so oversized files fail
  // instantly with a clear message instead of after a long, doomed transfer.
  const maxUploadMb = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 500;

  // Upload a file in sub-limit CHUNKS via XHR. Chunking is required because the
  // Next server (and proxies like Traefik) cap a single request body at ~10MB;
  // it also gives smooth progress and never blocks the main thread. The chunks of
  // one file share an uploadId; the server appends them and the last one finalizes.
  const uploadWithProgress = useCallback(
    (file: File): Promise<any> => {
      const CHUNK = 8 * 1024 * 1024; // 8MB — comfortably under the ~10MB body cap
      const total = Math.max(1, Math.ceil(file.size / CHUNK));
      const uploadId = crypto.randomUUID();

      const sendChunk = (i: number): Promise<any> =>
        new Promise((resolve, reject) => {
          const start = i * CHUNK;
          const blob = file.slice(start, Math.min(start + CHUNK, file.size));
          const xhr = new XMLHttpRequest();
          const qs =
            `filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}` +
            `&uploadId=${uploadId}&chunkIndex=${i}&chunks=${total}`;
          xhr.open('POST', `${API_BASE}/api/assets/${projectId}/upload?${qs}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) {
              const overall = Math.round(((start + ev.loaded) / Math.max(1, file.size)) * 100);
              setUploadProgress({ name: file.name, pct: Math.min(100, overall) });
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try { resolve(JSON.parse(xhr.responseText)); }
              catch { reject(new Error('Bad server response')); }
            } else {
              let msg = `${xhr.status}`;
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep status */ }
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.send(blob);
        });

      return (async () => {
        let last: any;
        for (let i = 0; i < total; i++) last = await sendChunk(i); // in order
        return last;
      })();
    },
    [projectId],
  );


  const modelOptionsForCli = useMemo(
    () => modelOptions.filter(option => option.cli === preferredCli),
    [modelOptions, preferredCli]
  );

  const selectedModelValue = useMemo(() => {
    return modelOptionsForCli.some(opt => opt.id === selectedModel) ? selectedModel : '';
  }, [modelOptionsForCli, selectedModel]);

  useEffect(() => {
    if (!disabled && !cliChangeDisabled && !modelChangeDisabled) {
      textareaRef.current?.focus();
    }
  }, [disabled, cliChangeDisabled, modelChangeDisabled]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }

    // Prevent multiple submissions with both state and ref locks. NOTE: no longer
    // blocked by isRunning — a turn in progress is fine (the parent queues the
    // message, CLI-style). Only the double-submit lock + upload guard apply.
    if (isSubmitting || disabled || isUploading || submissionLockRef.current) {
      return;
    }

    if (!message.trim() && uploadedImages.length === 0) {
      return;
    }

    // Set both state and ref locks immediately
    setIsSubmitting(true);
    submissionLockRef.current = true;

    try {
      // Send message and images separately - unified_manager will add image references
      onSendMessage(message.trim(), uploadedImages);
      setMessage('');
      setUploadedImages([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = '40px';
      }
    } finally {
      // Reset submission locks after a reasonable delay
      setTimeout(() => {
        setIsSubmitting(false);
        submissionLockRef.current = false;
      }, 200);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Skill autocomplete navigation takes precedence over send/newline.
    if (skillMenuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSkillActiveIdx((i) => (i + 1) % skillMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSkillActiveIdx((i) => (i - 1 + skillMatches.length) % skillMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const s = skillMatches[skillActiveIdx]; if (s) chooseSkill(s); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissedQuery(skillQuery); return; }
    }
    // CLI parity: Esc interrupts the running turn.
    if (e.key === 'Escape' && isRunning && onStop) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Check locks before submitting (isRunning is fine — the parent queues it).
      if (!isSubmitting && !disabled && !isUploading && !submissionLockRef.current && (message.trim() || uploadedImages.length > 0)) {
        handleSubmit();
      }
    }
  };

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = '40px';
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(scrollHeight, 200)}px`;
    }
  };

  // Apply a restored draft (queued text/images handed back after an interrupt).
  // Nonce-guarded so a re-render doesn't re-apply it, and appended to whatever the
  // user may have already typed.
  const lastRestoreNonceRef = useRef(0);
  useEffect(() => {
    if (!restoreDraft || restoreDraft.nonce === lastRestoreNonceRef.current) return;
    lastRestoreNonceRef.current = restoreDraft.nonce;
    if (restoreDraft.text) {
      setMessage((cur) => (cur.trim() ? `${cur.trim()}\n\n${restoreDraft.text}` : restoreDraft.text));
    }
    if (restoreDraft.images && restoreDraft.images.length > 0) {
      setUploadedImages((cur) => [...cur, ...restoreDraft.images!]);
    }
    setTimeout(() => { textareaRef.current?.focus(); adjustTextareaHeight(); }, 0);
  }, [restoreDraft]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {

    const files = e.target.files;
    if (!files) {
      return;
    }

    await handleFiles(files);
  };

  const removeImage = (id: string) => {
    setUploadedImages(prev => {
      const imageToRemove = prev.find(img => img.id === id);
      if (imageToRemove) {
        URL.revokeObjectURL(imageToRemove.url);
      }
      return prev.filter(img => img.id !== id);
    });
  };

  // Handle files (for both drag drop and file input)
  const handleFiles = useCallback(async (files: FileList) => {
    if (!projectId) {
      console.error('❌ No project ID available for image upload');
      toast.error('No project selected. Please choose a project first.');
      return;
    }

    // Note: image attachments need a CLI that can view images; other files are
    // just dropped into the project and referenced by path, so any CLI is fine.
    // The per-file loop below enforces the image-capability check only on images.


    setIsUploading(true);
    setUploadError(null);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const isImage = file.type.startsWith('image/');

        // Guard size up front so a large file fails fast with a clear message
        // instead of uploading for minutes and then being rejected by the server.
        if (file.size > maxUploadMb * 1024 * 1024) {
          setUploadError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(0)}MB — over the ${maxUploadMb}MB limit.`);
          continue;
        }

        // Non-image files (zips, PDFs, docs, data, …): upload into the project's
        // assets/ and reference the path in the message so the agent reads it
        // from disk. Works with any CLI.
        if (!isImage) {
          setUploadProgress({ name: file.name, pct: 0 });
          const r = await uploadWithProgress(file);
          const ref = `Attached file "${file.name}" → ${r.path} (read/unzip it from the project).`;
          setMessage((prev) => (prev.trim() ? `${prev.trimEnd()}\n${ref}` : ref));
          continue;
        }

        // Images require an image-capable CLI.
        if (!supportsImageUpload) {
          console.warn(`⚠️ Skipping image (CLI ${preferredCli} can't view images): ${file.name}`);
          setUploadError(`${preferredCli} can't view images — switch to Claude CLI for image input.`);
          continue;
        }

        setUploadProgress({ name: file.name, pct: 0 });
        const result = await uploadWithProgress(file);
        const imageUrl = URL.createObjectURL(file);

        const newImage: UploadedImage = {
          id: crypto.randomUUID(),
          filename: result.filename,
          path: result.absolute_path,
          url: imageUrl,
          assetUrl: `/api/assets/${projectId}/${result.filename}`,
          publicUrl: typeof result.public_url === 'string' ? result.public_url : undefined
        };

        setUploadedImages(prev => {
          const updatedImages = [...prev, newImage];
          return updatedImages;
        });
      }
    } catch (error) {
      console.error('❌ Upload failed:', error);
      // Inline, non-blocking error (alert() freezes the browser tab).
      setUploadError(`Upload failed: ${error instanceof Error ? error.message : 'please try again'}`);
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [projectId, supportsImageUpload, preferredCli, maxUploadMb, uploadWithProgress, toast]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [message]);

  // Handle clipboard paste for images
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!projectId || !supportsImageUpload) return;
      
      const items = e.clipboardData?.items;
      if (!items) return;
      
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
      
      if (imageFiles.length > 0) {
        e.preventDefault();
        const fileList = {
          length: imageFiles.length,
          item: (index: number) => imageFiles[index],
          [Symbol.iterator]: function* () {
            for (let i = 0; i < imageFiles.length; i++) {
              yield imageFiles[i];
            }
          }
        } as FileList;
        
        // Convert to FileList-like object
        Object.defineProperty(fileList, 'length', { value: imageFiles.length });
        imageFiles.forEach((file, index) => {
          Object.defineProperty(fileList, index, { value: file });
        });
        
        handleFiles(fileList);
      }
    };
    
    document.addEventListener('paste', handlePaste);
    
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [projectId, supportsImageUpload, handleFiles]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Any file is droppable (non-image files work with any CLI); only need a project.
    if (projectId) {
      setIsDragOver(true);
    } else {
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = projectId ? 'copy' : 'none';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);


    if (!projectId) {
      return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    } else {
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`bg-white dark:bg-gray-900 border rounded-2xl shadow-xs overflow-hidden transition-all duration-200 relative ${
      isDragOver
        ? 'border-blue-400 bg-blue-50'
        : 'border-gray-200 dark:border-gray-700'
    }`}
    >
      <div className="p-4 space-y-3">
        {/* Drag & Drop Overlay */}
        {isDragOver && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-blue-50 bg-opacity-95 rounded-2xl z-10 pointer-events-none">
            <div className="text-blue-600 text-lg font-medium mb-2">Drop file here</div>
            <div className="text-blue-500 text-sm">Images, zips, docs — the agent reads them from the project</div>
            <div className="mt-4">
              <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
          </div>
        )}

        {/* Upload progress — keeps a large file (e.g. a zip) from looking frozen */}
        {uploadProgress && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
            <div className="flex items-center justify-between text-xs text-blue-700 mb-1">
              <span className="truncate pr-2">Uploading {uploadProgress.name}</span>
              <span className="tabular-nums">{uploadProgress.pct}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-150" style={{ width: `${uploadProgress.pct}%` }} />
            </div>
          </div>
        )}
        {uploadError && (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span>{uploadError}</span>
            <button type="button" onClick={() => setUploadError(null)} className="shrink-0 text-red-500 hover:text-red-700" aria-label="Dismiss">✕</button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {projectId && (
              (!supportsImageUpload) ? (
                <div
                  className="flex items-center justify-center w-8 h-8 text-gray-300 cursor-not-allowed opacity-50 rounded-full"
                  title={
                    preferredCli === 'qwen'
                      ? 'Qwen Coder does not support image input. Please use Claude CLI.'
                      : preferredCli === 'cursor'
                      ? 'Cursor CLI does not support image input. Please use Claude CLI.'
                      : 'GLM CLI supports text only. Please use Claude CLI.'
                  }
                >
                  <ImageIcon className="h-4 w-4" />
                </div>
              ) : (
                <button
                  type="button"
                  aria-label="Upload files"
                  className="flex items-center justify-center w-8 h-8 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Upload images or files"
                  onClick={() => {
                    fileInputRef.current?.click();
                  }}
                >
                  <ImageIcon className="h-4 w-4" />
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleImageUpload}
                    disabled={isUploading || disabled}
                    className="hidden"
                  />
                </button>
              )
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col text-[11px] text-gray-500 dark:text-gray-400 ">
              <span>Assistant</span>
              <select
                value={preferredCli}
                onChange={(e) => {
                  onCliChange?.(e.target.value);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                disabled={cliChangeDisabled || !onCliChange}
                className="mt-1 w-32 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-xs py-1 px-2 focus:outline-hidden focus:ring-2 focus:ring-gray-300 disabled:opacity-60"
              >
                {cliOptions.length === 0 && <option value={preferredCli}>{preferredCli}</option>}
                {cliOptions.map(option => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.name}{!option.available ? ' (Unavailable)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col text-[11px] text-gray-500 dark:text-gray-400 ">
              <span>Model</span>
              <select
                value={selectedModelValue}
                onChange={(e) => {
                  const option = modelOptionsForCli.find(opt => opt.id === e.target.value);
                  if (option) {
                    onModelChange?.(option);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }
                }}
                disabled={modelChangeDisabled || !onModelChange || modelOptionsForCli.length === 0}
                className="mt-1 w-40 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-xs py-1 px-2 focus:outline-hidden focus:ring-2 focus:ring-gray-300 disabled:opacity-60"
              >
                {modelOptionsForCli.length === 0 && <option value="">No models available</option>}
                {modelOptionsForCli.length > 0 && selectedModelValue === '' && (
                  <option value="" disabled>Select model</option>
                )}
                {modelOptionsForCli.map(option => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.name}{!option.available ? ' (Unavailable)' : ''}
                  </option>
                ))}
              </select>
            </div>
            {preferredCli === 'claude' && (
              <div className="flex flex-col text-[11px] text-gray-500 dark:text-gray-400 ">
                <span>Thinking</span>
                <select
                  value={thinkingMode}
                  onChange={(e) => {
                    onThinkingModeChange?.(e.target.value as 'off' | 'auto' | 'forced');
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                  disabled={!onThinkingModeChange}
                  title="Extended thinking: Auto lets Claude decide, Deep forces maximum reasoning, Off is fastest."
                  className="mt-1 w-28 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-xs py-1 px-2 focus:outline-hidden focus:ring-2 focus:ring-gray-300 disabled:opacity-60"
                >
                  <option value="auto">Auto</option>
                  <option value="forced">Deep</option>
                  <option value="off">Off</option>
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="relative">
          {skillMenuOpen && (
            <div style={menuStyle} className="z-200 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl py-1">
              <div className="px-3 py-1.5 text-[11px] font-medium text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">Commands & skills · ↑↓ to navigate · ↵ to insert</div>
              {skillMatches.map((s, i) => (
                <button
                  type="button"
                  key={s.name}
                  // onMouseDown (not onClick) so we select before the textarea blurs.
                  onMouseDown={(e) => { e.preventDefault(); chooseSkill(s); }}
                  onMouseEnter={() => setSkillActiveIdx(i)}
                  className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 ${i === skillActiveIdx ? 'bg-[#DE7356]/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#DE7356]">/{s.name}</span>
                    <span className="text-[9px] uppercase tracking-wide text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded-sm">{s.scope}</span>
                  </span>
                  {s.description && <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{s.description}</span>}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full ring-offset-background placeholder:text-gray-500 disabled:cursor-not-allowed disabled:opacity-50 resize-none text-[16px] leading-snug md:text-base bg-transparent focus:bg-transparent rounded-md p-2 text-gray-900 dark:text-gray-50 border border-gray-200 dark:border-gray-700 "
            id="chatinput"
            placeholder={placeholder}
            disabled={disabled || isSubmitting}
            style={{ minHeight: '60px' }}
          />
          {isDragOver && projectId && supportsImageUpload && (
            <div className="pointer-events-none absolute inset-0 bg-blue-50/90 rounded-md flex items-center justify-center z-10 border-2 border-dashed border-blue-500">
              <div className="text-center">
                <div className="text-2xl mb-2">📸</div>
                <div className="text-sm font-medium text-blue-600 ">
                  Drop images here
                </div>
                <div className="text-xs text-blue-500 mt-1">
                  Supports: JPG, PNG, GIF, WEBP
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-full p-0.5">
            <button
              type="button"
              onClick={() => onModeChange?.('act')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                mode === 'act'
                  ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 shadow-xs'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 '
              }`}
              title="Act Mode: AI can modify code and create/delete files"
            >
              <Wrench className="h-3.5 w-3.5" />
              <span>Act</span>
            </button>
            <button
              type="button"
              onClick={() => onModeChange?.('chat')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                mode === 'chat'
                  ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 shadow-xs'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 '
              }`}
              title="Chat Mode: AI provides answers without modifying code"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Chat</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {isRunning && onStop && (
              <button
                type="button"
                onClick={onStop}
                title="Stop the current turn (Esc)"
                aria-label="Stop the current turn"
                className="flex size-8 items-center justify-center rounded-full border border-red-500/40 bg-red-500/10 text-red-500 transition-all duration-150 ease-out hover:bg-red-500 hover:text-white"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            )}
            <button
              id="chatinput-send-message-button"
              type="submit"
              className="flex size-8 items-center justify-center rounded-full bg-[#DE7356] text-white transition-all duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50 hover:bg-[#c9634a] hover:scale-110 disabled:hover:scale-100 disabled:hover:bg-[#DE7356]"
              disabled={disabled || isSubmitting || isUploading || (!message.trim() && uploadedImages.length === 0)}
            >
              <SendHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Uploaded Images Preview */}
      {uploadedImages.length > 0 && (
        <div className="px-4 pb-3">
          <div className="flex flex-wrap gap-2">
            {uploadedImages.map((image, index) => (
              <div key={image.id} className="relative group">
                <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={image.filename}
                    className="w-full h-full object-cover"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove image"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs px-1 py-0.5 rounded-b-lg truncate">
                  {image.filename}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {uploadedImages.length} image{uploadedImages.length > 1 ? 's' : ''} uploaded • Ready to send
          </div>
        </div>
      )}
    </form>
  );
}
