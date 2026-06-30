"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { SendHorizontal, MessageSquare, Image as ImageIcon, Wrench } from 'lucide-react';

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
  isRunning = false
}: ChatInputProps) {
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

    // Prevent multiple submissions with both state and ref locks
    if (isSubmitting || disabled || isUploading || isRunning || submissionLockRef.current) {
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Check all locks before submitting
      if (!isSubmitting && !disabled && !isUploading && !isRunning && !submissionLockRef.current && (message.trim() || uploadedImages.length > 0)) {
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

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('📸 File input change event triggered:', {
      hasFiles: !!e.target.files,
      fileCount: e.target.files?.length || 0,
      files: Array.from(e.target.files || []).map(f => ({
        name: f.name,
        size: f.size,
        type: f.type,
        lastModified: f.lastModified
      }))
    });

    const files = e.target.files;
    if (!files) {
      console.log('📸 No files selected');
      return;
    }

    console.log('📸 Calling handleFiles with files');
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
      alert('No project selected. Please choose a project first.');
      return;
    }

    // Note: image attachments need a CLI that can view images; other files are
    // just dropped into the project and referenced by path, so any CLI is fine.
    // The per-file loop below enforces the image-capability check only on images.

    console.log('📸 Starting upload process:', {
      projectId,
      cli: preferredCli,
      fileCount: files.length
    });

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

        console.log(`📸 Uploading image ${i + 1}/${files.length}:`, file.name);
        setUploadProgress({ name: file.name, pct: 0 });
        const result = await uploadWithProgress(file);
        console.log('✅ Image upload successful:', result);
        const imageUrl = URL.createObjectURL(file);

        const newImage: UploadedImage = {
          id: crypto.randomUUID(),
          filename: result.filename,
          path: result.absolute_path,
          url: imageUrl,
          assetUrl: `/api/assets/${projectId}/${result.filename}`,
          publicUrl: typeof result.public_url === 'string' ? result.public_url : undefined
        };

        console.log('📸 Created UploadedImage object:', newImage);
        setUploadedImages(prev => {
          const updatedImages = [...prev, newImage];
          console.log('📸 Updated uploadedImages state:', {
            totalCount: updatedImages.length,
            images: updatedImages.map(img => ({
              id: img.id,
              filename: img.filename,
              hasPath: !!img.path,
              hasAssetUrl: !!img.assetUrl,
              hasPublicUrl: !!img.publicUrl
            }))
          });
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
  }, [projectId, supportsImageUpload, preferredCli, maxUploadMb, uploadWithProgress]);

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
    console.log('📸 Drag enter event triggered:', { projectId });
    // Any file is droppable (non-image files work with any CLI); only need a project.
    if (projectId) {
      setIsDragOver(true);
    } else {
      console.log('📸 Drag enter ignored: no project selected');
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

    console.log('📸 Drop event triggered:', {
      hasFiles: !!e.dataTransfer.files,
      fileCount: e.dataTransfer.files?.length || 0,
      projectId,
      supportsImageUpload,
      files: Array.from(e.dataTransfer.files || []).map(f => ({
        name: f.name,
        size: f.size,
        type: f.type
      }))
    });

    if (!projectId) {
      console.log('📸 Drop event blocked: no project selected');
      return;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      console.log('📸 Calling handleFiles with dropped files');
      handleFiles(files);
    } else {
      console.log('📸 No files in drop event');
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`bg-white border rounded-2xl shadow-sm overflow-hidden transition-all duration-200 relative ${
      isDragOver
        ? 'border-blue-400 bg-blue-50'
        : 'border-gray-200'
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
                  className="flex items-center justify-center w-8 h-8 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div className="flex flex-col text-[11px] text-gray-500 ">
              <span>Assistant</span>
              <select
                value={preferredCli}
                onChange={(e) => {
                  onCliChange?.(e.target.value);
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                disabled={cliChangeDisabled || !onCliChange}
                className="mt-1 w-32 rounded-md border border-gray-300 bg-white text-gray-700 text-xs py-1 px-2 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-60"
              >
                {cliOptions.length === 0 && <option value={preferredCli}>{preferredCli}</option>}
                {cliOptions.map(option => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.name}{!option.available ? ' (Unavailable)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col text-[11px] text-gray-500 ">
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
                className="mt-1 w-40 rounded-md border border-gray-300 bg-white text-gray-700 text-xs py-1 px-2 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-60"
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
              <div className="flex flex-col text-[11px] text-gray-500 ">
                <span>Thinking</span>
                <select
                  value={thinkingMode}
                  onChange={(e) => {
                    onThinkingModeChange?.(e.target.value as 'off' | 'auto' | 'forced');
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                  disabled={!onThinkingModeChange}
                  title="Extended thinking: Auto lets Claude decide, Deep forces maximum reasoning, Off is fastest."
                  className="mt-1 w-28 rounded-md border border-gray-300 bg-white text-gray-700 text-xs py-1 px-2 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-60"
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
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full ring-offset-background placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50 resize-none text-[16px] leading-snug md:text-base bg-transparent focus:bg-transparent rounded-md p-2 text-gray-900 border border-gray-200 "
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
          <div className="flex items-center bg-gray-100 rounded-full p-0.5">
            <button
              type="button"
              onClick={() => onModeChange?.('act')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                mode === 'act'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 '
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
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 '
              }`}
              title="Chat Mode: AI provides answers without modifying code"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Chat</span>
            </button>
          </div>

          <button
            id="chatinput-send-message-button"
            type="submit"
            className="flex size-8 items-center justify-center rounded-full bg-gray-900 text-white transition-all duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50 hover:scale-110 disabled:hover:scale-100"
            disabled={disabled || isSubmitting || isUploading || (!message.trim() && uploadedImages.length === 0) || isRunning}
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Uploaded Images Preview */}
      {uploadedImages.length > 0 && (
        <div className="px-4 pb-3">
          <div className="flex flex-wrap gap-2">
            {uploadedImages.map((image, index) => (
              <div key={image.id} className="relative group">
                <div className="w-16 h-16 bg-gray-100 rounded-lg overflow-hidden border border-gray-300">
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
          <div className="mt-2 text-xs text-gray-500">
            {uploadedImages.length} image{uploadedImages.length > 1 ? 's' : ''} uploaded • Ready to send
          </div>
        </div>
      )}
    </form>
  );
}
