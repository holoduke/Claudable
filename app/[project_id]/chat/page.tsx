"use client";
import { useEffect, useState, useRef, useCallback, useMemo, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MotionDiv, MotionH3, MotionP, MotionButton } from '@/lib/motion';
import { useRouter, useSearchParams, useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { FaCode, FaDesktop, FaMobileAlt, FaPlay, FaStop, FaSync, FaCog, FaRocket, FaFolder, FaFolderOpen, FaFile, FaFileCode, FaCss3Alt, FaHtml5, FaJs, FaReact, FaPython, FaDocker, FaGitAlt, FaMarkdown, FaDatabase, FaPhp, FaJava, FaRust, FaVuejs, FaLock, FaHome, FaChevronUp, FaChevronRight, FaChevronDown, FaArrowLeft, FaArrowRight, FaRedo, FaFileImport, FaPuzzlePiece } from 'react-icons/fa';
import { SiTypescript, SiGo, SiRuby, SiSvelte, SiJson, SiYaml, SiCplusplus } from 'react-icons/si';
import { VscJson } from 'react-icons/vsc';
import ChatLog from '@/components/chat/ChatLog';
import { ProjectSettings } from '@/components/settings/ProjectSettings';
import UserMenu from '@/components/layout/UserMenu';
import VisualEditorPanel, { type SelectedElement } from '@/components/chat/VisualEditorPanel';
import CommentsLayer, { type CommentPin, type ComposeAnchor } from '@/components/chat/CommentsLayer';
import CommentsListPanel from '@/components/chat/CommentsListPanel';
import { useToast } from '@/components/ui/Toast';
import ThemeToggle from '@/components/ui/ThemeToggle';
import ArchitectureModal from '@/components/chat/ArchitectureModal';
import ChatInput from '@/components/chat/ChatInput';
import DesignImportModal from '@/components/chat/DesignImportModal';
import SkillsModal from '@/components/chat/SkillsModal';
import { formatTimeAgo, getFileLanguage, escapeHtml } from '@/lib/utils/format';
import { ChatErrorBoundary } from '@/components/ErrorBoundary';
import { useUserRequests } from '@/hooks/useUserRequests';
import { useGlobalSettings } from '@/contexts/GlobalSettingsContext';
import { getDefaultModelForCli, getModelDisplayName } from '@/lib/constants/cliModels';
import {
  ACTIVE_CLI_BRAND_COLORS,
  ACTIVE_CLI_IDS,
  ACTIVE_CLI_MODEL_OPTIONS,
  ACTIVE_CLI_NAME_MAP,
  DEFAULT_ACTIVE_CLI,
  buildActiveModelOptions,
  normalizeModelForCli,
  sanitizeActiveCli,
  type ActiveCliId,
  type ActiveModelOption,
} from '@/lib/utils/cliOptions';

// No longer loading ProjectSettings (managed by global settings on main page)

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/** Named device presets for the preview device selector (portrait dimensions). */
type DevicePreset = { id: string; name: string; w?: number; h?: number; desktop?: boolean };
const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'desktop', name: 'Responsive · Desktop', desktop: true },
  { id: 'iphone-se', name: 'iPhone SE', w: 375, h: 667 },
  { id: 'iphone-14', name: 'iPhone 14 / 15', w: 390, h: 844 },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', w: 430, h: 932 },
  { id: 'pixel-7', name: 'Pixel 7', w: 412, h: 915 },
  { id: 'galaxy-s20', name: 'Samsung Galaxy S20', w: 360, h: 800 },
  { id: 'galaxy-fold', name: 'Galaxy Z Fold', w: 344, h: 882 },
  { id: 'ipad-mini', name: 'iPad Mini', w: 768, h: 1024 },
  { id: 'ipad-air', name: 'iPad Air', w: 820, h: 1180 },
  { id: 'ipad-pro-11', name: 'iPad Pro 11"', w: 834, h: 1194 },
  { id: 'ipad-pro-129', name: 'iPad Pro 12.9"', w: 1024, h: 1366 },
  { id: 'surface-pro', name: 'Surface Pro', w: 912, h: 1368 },
];

/** Human relative time, e.g. "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
const assistantBrandColors = ACTIVE_CLI_BRAND_COLORS;

const CLI_LABELS = ACTIVE_CLI_NAME_MAP;

const CLI_ORDER = ACTIVE_CLI_IDS;

const sanitizeCli = (cli?: string | null) => sanitizeActiveCli(cli, DEFAULT_ACTIVE_CLI);

const sanitizeModel = (cli: string, model?: string | null) => normalizeModelForCli(cli, model, DEFAULT_ACTIVE_CLI);

// Function to convert hex to CSS filter for tinting white images
// Since the original image is white (#FFFFFF), we can apply filters more accurately
const hexToFilter = (hex: string): string => {
  // For white source images, we need to invert and adjust
  const filters: { [key: string]: string } = {
    '#DE7356': 'brightness(0) saturate(100%) invert(52%) sepia(73%) saturate(562%) hue-rotate(336deg) brightness(95%) contrast(91%)',
    '#000000': 'brightness(0) saturate(100%)',
    '#11A97D': 'brightness(0) saturate(100%) invert(57%) sepia(30%) saturate(747%) hue-rotate(109deg) brightness(90%) contrast(92%)',
    '#1677FF': 'brightness(0) saturate(100%) invert(40%) sepia(86%) saturate(1806%) hue-rotate(201deg) brightness(98%) contrast(98%)',
  };
  return filters[hex] || filters['#DE7356'];
};

type Entry = { path: string; type: 'file'|'dir'; size?: number };
type ProjectStatus = 'initializing' | 'active' | 'failed';

type CliStatusSnapshot = {
  available?: boolean;
  configured?: boolean;
  models?: string[];
};

type ModelOption = Omit<ActiveModelOption, 'cli'> & { cli: string };

const buildModelOptions = (statuses: Record<string, CliStatusSnapshot>): ModelOption[] =>
  buildActiveModelOptions(statuses).map(option => ({
    ...option,
    cli: option.cli,
  }));

// TreeView component for VSCode-style file explorer
interface TreeViewProps {
  entries: Entry[];
  selectedFile: string;
  expandedFolders: Set<string>;
  folderContents: Map<string, Entry[]>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onLoadFolder: (path: string) => Promise<void>;
  level: number;
  parentPath?: string;
  getFileIcon: (entry: Entry) => React.ReactElement;
}

function TreeView({ entries, selectedFile, expandedFolders, folderContents, onToggleFolder, onSelectFile, onLoadFolder, level, parentPath = '', getFileIcon }: TreeViewProps) {
  // Ensure entries is an array
  if (!entries || !Array.isArray(entries)) {
    return null;
  }
  
  // Group entries by directory
  const sortedEntries = [...entries].sort((a, b) => {
    // Directories first
    if (a.type === 'dir' && b.type === 'file') return -1;
    if (a.type === 'file' && b.type === 'dir') return 1;
    // Then alphabetical
    return a.path.localeCompare(b.path);
  });

  return (
    <>
      {sortedEntries.map((entry, index) => {
        // entry.path should already be the full path from API
        const fullPath = entry.path;
        let entryKey =
          fullPath && typeof fullPath === 'string' && fullPath.trim().length > 0
            ? fullPath.trim()
            : (entry as any)?.name && typeof (entry as any).name === 'string' && (entry as any).name.trim().length > 0
            ? `${parentPath || 'root'}::__named_${(entry as any).name.trim()}`
            : '';
        if (!entryKey || entryKey.trim().length === 0) {
          entryKey = `${parentPath || 'root'}::__entry_${level}_${index}_${entry.type}`;
        }
        const isExpanded = expandedFolders.has(fullPath);
        const indent = level * 8;
        
        return (
          <div key={entryKey}>
            <div
              className={`group flex items-center h-[22px] px-2 cursor-pointer ${
                selectedFile === fullPath 
                  ? 'bg-blue-100 ' 
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800 '
              }`}
              style={{ paddingLeft: `${8 + indent}px` }}
              onClick={async () => {
                if (entry.type === 'dir') {
                  // Load folder contents if not already loaded
                  if (!folderContents.has(fullPath)) {
                    await onLoadFolder(fullPath);
                  }
                  onToggleFolder(fullPath);
                } else {
                  onSelectFile(fullPath);
                }
              }}
            >
              {/* Chevron for folders */}
              <div className="w-4 flex items-center justify-center mr-0.5">
                {entry.type === 'dir' && (
                  isExpanded ? 
                    <span className="w-2.5 h-2.5 text-gray-600 dark:text-gray-300 flex items-center justify-center"><FaChevronDown size={10} /></span> : 
                    <span className="w-2.5 h-2.5 text-gray-600 dark:text-gray-300 flex items-center justify-center"><FaChevronRight size={10} /></span>
                )}
              </div>
              
              {/* Icon */}
              <span className="w-4 h-4 flex items-center justify-center mr-1.5">
                {entry.type === 'dir' ? (
                  isExpanded ? 
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FaFolderOpen size={16} /></span> : 
                    <span className="text-amber-600 w-4 h-4 flex items-center justify-center"><FaFolder size={16} /></span>
                ) : (
                  getFileIcon(entry)
                )}
              </span>
              
              {/* File/Folder name */}
              <span className={`text-[13px] leading-[22px] ${
                selectedFile === fullPath ? 'text-blue-700 ' : 'text-gray-700 dark:text-gray-200 '
              }`} style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                {level === 0 ? (entry.path.split('/').pop() || entry.path) : (entry.path.split('/').pop() || entry.path)}
              </span>
            </div>
            
            {/* Render children if expanded */}
            {entry.type === 'dir' && isExpanded && folderContents.has(fullPath) && (
              <TreeView
                entries={folderContents.get(fullPath) || []}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                folderContents={folderContents}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                onLoadFolder={onLoadFolder}
                level={level + 1}
                parentPath={fullPath}
                getFileIcon={getFileIcon}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function ChatPage() {
  const params = useParams<{ project_id: string }>();
  const projectId = params?.project_id ?? '';
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // NEW: UserRequests state management
  const {
    hasActiveRequests,
    createRequest,
    startRequest,
    completeRequest
  } = useUserRequests({ projectId });
  
  const [projectName, setProjectName] = useState<string>('');
  const [projectDescription, setProjectDescription] = useState<string>('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [content, setContent] = useState<string>('');
  const [editedContent, setEditedContent] = useState<string>('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<'idle' | 'success' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('.');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));
  const [folderContents, setFolderContents] = useState<Map<string, Entry[]>>(new Map());
  const [prompt, setPrompt] = useState('');

  // Ref to store add/remove message handlers from ChatLog
  const messageHandlersRef = useRef<{
    add: (message: any) => void;
    remove: (messageId: string) => void;
  } | null>(null);

  // Ref to track pending requests for deduplication
  const pendingRequestsRef = useRef<Set<string>>(new Set());

  // Stable message handlers to prevent reassignment issues
  const stableMessageHandlers = useRef<{
    add: (message: any) => void;
    remove: (messageId: string) => void;
  } | null>(null);

  // Track active optimistic messages by requestId
  const optimisticMessagesRef = useRef<Map<string, any>>(new Map());
  const [mode, setMode] = useState<'act' | 'chat'>('act');
  const [isRunning, setIsRunning] = useState(false);
  // CLI-style message queue: messages typed while a turn is running wait here and
  // auto-send (one per turn) when the current turn finishes.
  const [queuedMessages, setQueuedMessages] = useState<Array<{ message: string; images: any[] }>>([]);
  const prevBusyRef = useRef(false);
  const [isSseFallbackActive, setIsSseFallbackActive] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const toast = useToast();
  // --- Visual editor (inline edit mode) ---
  const [editMode, setEditMode] = useState(false);
  const [selectedEl, setSelectedEl] = useState<SelectedElement | null>(null);
  const [styleEdits, setStyleEdits] = useState<Record<string, string>>({});
  const [textEdit, setTextEdit] = useState<string | null>(null);
  const [persistingEdit, setPersistingEdit] = useState(false);
  // --- Comments (pinned review annotations) ---
  const [commentMode, setCommentMode] = useState(false);
  const [comments, setComments] = useState<CommentPin[]>([]);
  const [pinPositions, setPinPositions] = useState<Record<string, { x: number | null; y: number | null }>>({});
  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [composeAnchor, setComposeAnchor] = useState<ComposeAnchor | null>(null);
  // True once the preview iframe's plugin has reported in for the current load.
  // Reset on navigation so we don't push pins/scroll into a still-loading page.
  const [previewReady, setPreviewReady] = useState(false);
  const previewReadyRef = useRef(false);
  previewReadyRef.current = previewReady;
  // The injected review bridge is Nuxt-only. If the iframe loads but never
  // reports in, the stack has no bridge (Next.js/Angular) → gate the review
  // tools with a hint instead of leaving silently-dead buttons.
  const [bridgeAbsent, setBridgeAbsent] = useState(false);
  const bridgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Comments overview list (left pane): ALL comments across every route.
  const [showCommentsList, setShowCommentsList] = useState(false);
  const [allComments, setAllComments] = useState<(CommentPin & { route: string })[]>([]);
  const commentModeRef = useRef(false);
  commentModeRef.current = commentMode;
  const editModeRef = useRef(false);
  editModeRef.current = editMode;
  // Latest pins/active id, read by the stable claudable-preview handler so it can
  // re-push them after ANY iframe (re)load — not just parent-initiated ones.
  const commentsRef = useRef<CommentPin[]>([]);
  commentsRef.current = comments;
  const activePinIdRef = useRef<string | null>(null);
  activePinIdRef.current = activePinId;
  // A comment we're navigating to (may be on another route): fired once its
  // route's pins have loaded so the preview can scroll to it.
  const pendingScrollRef = useRef<{ id: string; anchorSelector: string; route: string } | null>(null);
  // Runtime errors reported by the preview (for one-click "fix with AI").
  const [previewErrors, setPreviewErrors] = useState<{ kind: string; message: string; at: string }[]>([]);
  const [shareCopied, setShareCopied] = useState(false);
  const [deviceId, setDeviceId] = useState<string>('desktop');
  const [orientation, setOrientation] = useState<'portrait'|'landscape'>('portrait');
  const [deviceScale, setDeviceScale] = useState(1);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [deviceViewport, setDeviceViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const deviceViewportRef = useRef<HTMLDivElement>(null);
  // Always points at the latest runAct closure (used by persistEdits).
  const runActRef = useRef<((m?: string, i?: any[]) => Promise<void>) | null>(null);
  const currentRouteRef = useRef<string>('/');
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<{name: string; url: string; base64?: string; path?: string}[]>([]);
  const [isInitializing, setIsInitializing] = useState(true);
  // Initialize states with default values, will be loaded from localStorage in useEffect
  const [hasInitialPrompt, setHasInitialPrompt] = useState<boolean>(false);
  const [agentWorkComplete, setAgentWorkComplete] = useState<boolean>(false);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('initializing');
  const [initializationMessage, setInitializationMessage] = useState('Starting project initialization...');
  const [initialPromptSent, setInitialPromptSent] = useState(false);
  const initialPromptSentRef = useRef(false);
  const [showPublishPanel, setShowPublishPanel] = useState(false);
  const [showDesignImport, setShowDesignImport] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showArchitecture, setShowArchitecture] = useState(false);

  // Resizable chat/preview split. Width of the left chat panel as a % of the
  // window; drag the divider to resize, persisted to localStorage.
  const CHAT_WIDTH_KEY = 'claudable:chatWidthPct';
  const CHAT_WIDTH_MIN = 20;
  const CHAT_WIDTH_MAX = 70;
  const [chatWidthPct, setChatWidthPct] = useState(30);
  const [isResizing, setIsResizing] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const chatWidthRef = useRef(30);

  useEffect(() => {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    if (saved >= CHAT_WIDTH_MIN && saved <= CHAT_WIDTH_MAX) {
      setChatWidthPct(saved);
      chatWidthRef.current = saved;
    }
  }, []);

  const startChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // A full-window overlay (rendered while isResizing) sits above the preview
    // iframe so the cross-origin iframe can't swallow mousemove/mouseup — without
    // it, dragging over the preview freezes and releasing never registers.
    setIsResizing(true);
    const onMove = (ev: MouseEvent) => {
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, pct));
      chatWidthRef.current = clamped;
      setChatWidthPct(clamped);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setIsResizing(false);
      localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(chatWidthRef.current)));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);
  const [publishLoading, setPublishLoading] = useState(false);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [vercelConnected, setVercelConnected] = useState<boolean | null>(null);
  // Git provider config (server-driven). For the self-hosted Gitea flow, deploys
  // happen via the Actions runner so Vercel is not required.
  const [gitProvider, setGitProvider] = useState<string | null>(null);
  const [gitDeployDomain, setGitDeployDomain] = useState<string | null>(null);
  const [githubRepoName, setGithubRepoName] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<'idle' | 'deploying' | 'ready' | 'error'>('idle');
  const deployPollRef = useRef<NodeJS.Timeout | null>(null);
  // Set when an auto-start fails, to stop the effect from re-firing start() every
  // ~2s (a tight retry loop that floods /preview/start). Cleared on success or
  // when the user explicitly clicks the Play button.
  const previewStartFailedRef = useRef(false);
  // Real CI deploy run details (Gitea Actions) for the publish UI.
  const [deployRun, setDeployRun] = useState<{ state: string; runNumber?: number; url?: string; title?: string; sha?: string; updatedAt?: string } | null>(null);
  const giteaPollRef = useRef<NodeJS.Timeout | null>(null);
  const [isStartingPreview, setIsStartingPreview] = useState(false);
  const [previewInitializationMessage, setPreviewInitializationMessage] = useState('Starting development server...');
  const [cliStatuses, setCliStatuses] = useState<Record<string, CliStatusSnapshot>>({});
  const [conversationId, setConversationId] = useState<string>(() => {
    if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
    return '';
  });
  const [preferredCli, setPreferredCli] = useState<ActiveCliId>(DEFAULT_ACTIVE_CLI);
  const [selectedModel, setSelectedModel] = useState<string>(getDefaultModelForCli(DEFAULT_ACTIVE_CLI));
  const [usingGlobalDefaults, setUsingGlobalDefaults] = useState<boolean>(true);
  const [thinkingMode, setThinkingMode] = useState<'off' | 'auto' | 'forced'>('auto');
  const [isUpdatingModel, setIsUpdatingModel] = useState<boolean>(false);
  const [currentRoute, setCurrentRoute] = useState<string>('/');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);
  const editedContentRef = useRef<string>('');
  const [isFileUpdating, setIsFileUpdating] = useState(false);
  const activeBrandColor =
    assistantBrandColors[preferredCli] || assistantBrandColors[DEFAULT_ACTIVE_CLI];
  const modelOptions = useMemo(() => buildModelOptions(cliStatuses), [cliStatuses]);
  const cliOptions = useMemo(
    () => CLI_ORDER.map(cli => ({
      id: cli,
      name: CLI_LABELS[cli] || cli,
      available: Boolean(cliStatuses[cli]?.available && cliStatuses[cli]?.configured)
    })),
    [cliStatuses]
  );

  const updatePreferredCli = useCallback((cli: string) => {
    const sanitized = sanitizeCli(cli);
    setPreferredCli(sanitized);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('selectedAssistant', sanitized);
    }
  }, []);

  const updateSelectedModel = useCallback((model: string, cliOverride?: string) => {
    const effectiveCli = cliOverride ? sanitizeCli(cliOverride) : preferredCli;
    const sanitized = sanitizeModel(effectiveCli, model);
    setSelectedModel(sanitized);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('selectedModel', sanitized);
    }
  }, [preferredCli]);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  // Capture a dashboard thumbnail once the preview is up (best-effort, once per
  // project). Delayed so the dev server has rendered before the screenshot.
  const thumbCapturedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!previewUrl || thumbCapturedForRef.current === projectId) return;
    const t = setTimeout(() => {
      thumbCapturedForRef.current = projectId;
      fetch(`${API_BASE}/api/projects/${projectId}/thumbnail`, { method: 'POST' }).catch(() => {});
    }, 7000);
    return () => clearTimeout(t);
  }, [previewUrl, projectId]);

  // Re-capture the thumbnail whenever an agent run completes, so the dashboard
  // tile always reflects the latest version of the site. Fires on the
  // running -> not-running transition, after the preview has hot-reloaded.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const justFinished = wasRunningRef.current && !isRunning;
    wasRunningRef.current = isRunning;
    if (!justFinished || !previewUrlRef.current) return;
    const t = setTimeout(() => {
      fetch(`${API_BASE}/api/projects/${projectId}/thumbnail`, { method: 'POST' }).catch(() => {});
    }, 6000);
    return () => clearTimeout(t);
  }, [isRunning, projectId]);

  // Flush the queued messages one at a time: when a turn finishes (busy -> idle),
  // send the next queued message. Edge-detected so we send exactly one per turn.
  useEffect(() => {
    const busy = isRunning || hasActiveRequests;
    if (prevBusyRef.current && !busy && queuedMessages.length > 0) {
      const next = queuedMessages[0];
      setQueuedMessages((q) => q.slice(1));
      runActRef.current?.(next.message, next.images);
    }
    prevBusyRef.current = busy;
  }, [isRunning, hasActiveRequests, queuedMessages]);

  const sendInitialPrompt = useCallback(async (initialPrompt: string) => {
    if (initialPromptSent) {
      return;
    }

    setAgentWorkComplete(false);
    localStorage.setItem(`project_${projectId}_taskComplete`, 'false');

    const requestId = crypto.randomUUID();

    try {
      setIsRunning(true);
      setInitialPromptSent(true);

      const requestBody = {
        instruction: initialPrompt,
        images: [],
        isInitialPrompt: true,
        cliPreference: preferredCli,
        conversationId: conversationId || undefined,
        requestId,
        selectedModel,
        thinkingMode,
      };

      const r = await fetch(`${API_BASE}/api/chat/${projectId}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!r.ok) {
        const errorText = await r.text();
        console.error('❌ API Error:', errorText);
        setInitialPromptSent(false);
        return;
      }

      const result = await r.json();
      const returnedConversationId =
        typeof result?.conversationId === 'string'
          ? result.conversationId
          : typeof result?.conversation_id === 'string'
          ? result.conversation_id
          : undefined;
      if (returnedConversationId) {
        setConversationId(returnedConversationId);
      }

      const resolvedRequestId =
        typeof result?.requestId === 'string'
          ? result.requestId
          : typeof result?.request_id === 'string'
          ? result.request_id
          : requestId;
      const userMessageId =
        typeof result?.userMessageId === 'string'
          ? result.userMessageId
          : typeof result?.user_message_id === 'string'
          ? result.user_message_id
          : '';

      createRequest(resolvedRequestId, userMessageId, initialPrompt, 'act');
      setPrompt('');

      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('initial_prompt');
      window.history.replaceState({}, '', newUrl.toString());
    } catch (error) {
      console.error('Error sending initial prompt:', error);
      setInitialPromptSent(false);
    } finally {
      setIsRunning(false);
    }
  }, [initialPromptSent, preferredCli, conversationId, projectId, selectedModel, thinkingMode, createRequest]);

  // Guarded trigger that can be called from multiple places safely
  const triggerInitialPromptIfNeeded = useCallback(() => {
    const initialPromptFromUrl = searchParams?.get('initial_prompt');
    if (!initialPromptFromUrl) return;
    if (initialPromptSentRef.current) return;
    // Synchronously guard to prevent double ACT calls
    initialPromptSentRef.current = true;
    setInitialPromptSent(true);
    
    // Store the selected model and assistant in sessionStorage when returning
    const cliFromUrl = searchParams?.get('cli');
    const modelFromUrl = searchParams?.get('model');
    if (cliFromUrl) {
      const sanitizedCli = sanitizeCli(cliFromUrl);
      sessionStorage.setItem('selectedAssistant', sanitizedCli);
      if (modelFromUrl) {
        sessionStorage.setItem('selectedModel', sanitizeModel(sanitizedCli, modelFromUrl));
      }
    } else if (modelFromUrl) {
      sessionStorage.setItem('selectedModel', sanitizeModel(preferredCli, modelFromUrl));
    }
    
    // Don't show the initial prompt in the input field
    // setPrompt(initialPromptFromUrl);
    setTimeout(() => {
      sendInitialPrompt(initialPromptFromUrl);
    }, 300);
  }, [searchParams, sendInitialPrompt, preferredCli]);

const loadCliStatuses = useCallback(() => {
  const snapshot: Record<string, CliStatusSnapshot> = {};
  ACTIVE_CLI_IDS.forEach(id => {
    const models = ACTIVE_CLI_MODEL_OPTIONS[id]?.map(model => model.id) ?? [];
    snapshot[id] = {
      available: true,
      configured: true,
      models,
    };
  });
  setCliStatuses(snapshot);
}, []);

const persistProjectPreferences = useCallback(
  async (changes: { preferredCli?: string; selectedModel?: string }) => {
    if (!projectId) return;
    const payload: Record<string, unknown> = {};
    if (changes.preferredCli) {
      const sanitizedPreferredCli = sanitizeCli(changes.preferredCli);
      payload.preferredCli = sanitizedPreferredCli;
      payload.preferred_cli = sanitizedPreferredCli;
    }
    if (changes.selectedModel) {
      const targetCli = sanitizeCli(changes.preferredCli ?? preferredCli);
      const normalized = sanitizeModel(targetCli, changes.selectedModel);
      payload.selectedModel = normalized;
      payload.selected_model = normalized;
    }
    if (Object.keys(payload).length === 0) return;

    const response = await fetch(`${API_BASE}/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to update project preferences');
    }

    const result = await response.json().catch(() => null);
    return result?.data ?? result;
  },
  [projectId, preferredCli]
);

  const handleModelChange = useCallback(
    async (option: ModelOption, opts?: { skipCliUpdate?: boolean; overrideCli?: string }) => {
      if (!projectId || !option) return;

      const { skipCliUpdate = false, overrideCli } = opts || {};
      const targetCli = sanitizeCli(overrideCli ?? option.cli);
      const sanitizedModelId = sanitizeModel(targetCli, option.id);

      const previousCli = preferredCli;
      const previousModel = selectedModel;

      if (targetCli === previousCli && sanitizedModelId === previousModel) {
        return;
      }

      setUsingGlobalDefaults(false);
      updatePreferredCli(targetCli);
      updateSelectedModel(option.id, targetCli);

      setIsUpdatingModel(true);

      try {
        const preferenceChanges: { preferredCli?: string; selectedModel?: string } = {
          selectedModel: sanitizedModelId,
        };
        if (!skipCliUpdate && targetCli !== previousCli) {
          preferenceChanges.preferredCli = targetCli;
        }

        await persistProjectPreferences(preferenceChanges);

        const cliLabel = CLI_LABELS[targetCli] || targetCli;
        const modelLabel = getModelDisplayName(targetCli, sanitizedModelId);
        try {
          await fetch(`${API_BASE}/api/chat/${projectId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `Switched to ${cliLabel} (${modelLabel})`,
              role: 'system',
              message_type: 'info',
              cli_source: targetCli,
              conversation_id: conversationId || undefined,
            }),
          });
        } catch (messageError) {
          console.warn('Failed to record model switch message:', messageError);
        }

        loadCliStatuses();
      } catch (error) {
        console.error('Failed to update model preference:', error);
        updatePreferredCli(previousCli);
        updateSelectedModel(previousModel, previousCli);
        alert('Failed to update model. Please try again.');
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [projectId, preferredCli, selectedModel, conversationId, loadCliStatuses, persistProjectPreferences, updatePreferredCli, updateSelectedModel]
  );

  useEffect(() => {
    loadCliStatuses();
  }, [loadCliStatuses]);

  const handleCliChange = useCallback(
    async (cliId: string) => {
      if (!projectId) return;
      if (cliId === preferredCli) return;

      setUsingGlobalDefaults(false);

      const candidateModels = modelOptions.filter(option => option.cli === cliId);
      const fallbackOption =
        candidateModels.find(option => option.id === selectedModel && option.available) ||
        candidateModels.find(option => option.available) ||
        candidateModels[0];

      if (fallbackOption) {
        await handleModelChange(fallbackOption, { overrideCli: cliId });
        return;
      }

      const previousCli = preferredCli;
      const previousModel = selectedModel;
      setIsUpdatingModel(true);

      try {
        updatePreferredCli(cliId);
        const defaultModel = getDefaultModelForCli(cliId);
        updateSelectedModel(defaultModel, cliId);
        await persistProjectPreferences({ preferredCli: cliId, selectedModel: defaultModel });
        loadCliStatuses();
      } catch (error) {
        console.error('Failed to update CLI preference:', error);
        updatePreferredCli(previousCli);
        updateSelectedModel(previousModel, previousCli);
        alert('Failed to update CLI. Please try again.');
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [projectId, preferredCli, selectedModel, modelOptions, handleModelChange, loadCliStatuses, persistProjectPreferences, updatePreferredCli, updateSelectedModel]
  );

  useEffect(() => {
    if (!modelOptions.length) return;
    const hasSelected = modelOptions.some(option => option.cli === preferredCli && option.id === selectedModel);
    if (!hasSelected) {
      const fallbackOption = modelOptions.find(option => option.cli === preferredCli && option.available)
        || modelOptions.find(option => option.cli === preferredCli)
        || modelOptions.find(option => option.available)
        || modelOptions[0];
      if (fallbackOption) {
        void handleModelChange(fallbackOption);
      }
    }
  }, [modelOptions, preferredCli, selectedModel, handleModelChange]);

  const loadDeployStatus = useCallback(async () => {
    try {
      // Use the same API as ServiceSettings to check actual project service connections
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/services`);
      if (response.status === 404) {
        setGithubConnected(false);
        setVercelConnected(false);
        setPublishedUrl(null);
        setDeploymentStatus('idle');
        return;
      }

      if (response.ok) {
        const connections = await response.json();
        const githubConnection = connections.find((conn: any) => conn.provider === 'github');
        const vercelConnection = connections.find((conn: any) => conn.provider === 'vercel');
        
        // Check actual project connections (not just token existence)
        setGithubConnected(!!githubConnection);
        setVercelConnected(!!vercelConnection);
        const ghData = githubConnection?.service_data as Record<string, any> | undefined;
        setGithubRepoName(
          (ghData?.repo_name as string) ||
            (typeof ghData?.repo_url === 'string' ? ghData.repo_url.split('/').pop() : null) ||
            null,
        );
        
        // Set published URL only if actually deployed
        if (vercelConnection && vercelConnection.service_data) {
          const sd = vercelConnection.service_data;
          // Only use actual deployment URLs, not predicted ones
          const rawUrl = sd.last_deployment_url || null;
          const url = rawUrl ? (String(rawUrl).startsWith('http') ? String(rawUrl) : `https://${rawUrl}`) : null;
          setPublishedUrl(url || null);
          if (url) {
            setDeploymentStatus('ready');
          } else {
            setDeploymentStatus('idle');
          }
        } else {
          setPublishedUrl(null);
          setDeploymentStatus('idle');
        }
      } else {
        setGithubConnected(false);
        setVercelConnected(false);
        setPublishedUrl(null);
        setDeploymentStatus('idle');
      }

    } catch (e) {
      console.warn('Failed to load deploy status', e);
      setGithubConnected(false);
      setVercelConnected(false);
      setPublishedUrl(null);
      setDeploymentStatus('idle');
    }
  }, [projectId]);

  // Load the server's git provider config once (drives Gitea-vs-GitHub publish UI).
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/git/provider`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        if (typeof d.provider === 'string') setGitProvider(d.provider);
        if (typeof d.deployDomain === 'string') setGitDeployDomain(d.deployDomain);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const isGitea = gitProvider === 'gitea';

  // In the Gitea flow the live URL is derived from the repo + deploy domain.
  useEffect(() => {
    if (isGitea && githubConnected && githubRepoName && gitDeployDomain) {
      setPublishedUrl((prev) => prev || `https://${githubRepoName}.${gitDeployDomain}`);
    }
  }, [isGitea, githubConnected, githubRepoName, gitDeployDomain]);

  // Poll the REAL Gitea Actions deploy run (queued -> running -> success/failure)
  // instead of guessing with a timer. Stops on a terminal state or timeout.
  // Poll the REAL Gitea Actions deploy run. `baselineRun` is the latest run
  // number BEFORE this publish — we only treat a run NEWER than it as "this
  // deploy", otherwise the first poll reads the previous (already-finished) run
  // and stops instantly (the "first click does nothing" bug).
  const startGiteaDeployPolling = useCallback((baselineRun?: number | null) => {
    if (giteaPollRef.current) { clearInterval(giteaPollRef.current); giteaPollRef.current = null; }
    setDeploymentStatus('deploying');
    const startedAt = Date.now();
    const stop = () => { if (giteaPollRef.current) { clearInterval(giteaPollRef.current); giteaPollRef.current = null; } };
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/projects/${projectId}/deploy/status`, { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (d?.found) {
            const isNewRun = baselineRun == null
              || (typeof d.runNumber === 'number' && d.runNumber > baselineRun);
            if (!isNewRun) {
              // The new run hasn't registered yet — keep showing "queued".
              setDeployRun({ state: 'queued' });
              // If no new run appears within 40s, there was nothing to deploy
              // (no changes) — the site is already live from the prior run.
              if (Date.now() - startedAt > 40000) {
                setDeploymentStatus('ready'); stop(); return;
              }
            } else {
              setDeployRun({ state: d.state, runNumber: d.runNumber, url: d.url, title: d.title, sha: d.sha, updatedAt: d.updatedAt });
              if (d.state === 'success') {
                if (d.liveUrl) setPublishedUrl(d.liveUrl);
                setDeploymentStatus('ready'); stop(); return;
              }
              if (d.state === 'failure' || d.state === 'cancelled') {
                setDeploymentStatus('error'); stop(); return;
              }
            }
          }
        }
      } catch {
        // transient; keep polling
      }
      // Safety timeout (~6 min) so it never spins forever.
      if (Date.now() - startedAt > 6 * 60 * 1000) stop();
    };
    poll();
    giteaPollRef.current = setInterval(poll, 4000);
  }, [projectId]);

  // When the Publish modal opens (Gitea flow), reflect the real current/last
  // deploy run so the user always sees actual status — and resume polling if a
  // run is still in progress.
  useEffect(() => {
    if (!showPublishPanel || !isGitea || !githubConnected) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/projects/${projectId}/deploy/status`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.found) return;
        setDeployRun({ state: d.state, runNumber: d.runNumber, url: d.url, title: d.title, sha: d.sha, updatedAt: d.updatedAt });
        if (d.state === 'success') {
          // Only record the live URL — do NOT mark 'ready'. Marking ready here
          // would show "Published successfully" the moment the popup opens,
          // before the user has clicked anything. A neutral "Currently live"
          // block shows the URL instead.
          if (d.liveUrl) setPublishedUrl(d.liveUrl);
        } else if ((d.state === 'running' || d.state === 'queued') && !giteaPollRef.current) {
          // A deploy is genuinely in progress right now — reflect it.
          startGiteaDeployPolling();
        }
        // failure/cancelled on open: leave idle so the user can just re-publish.
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showPublishPanel, isGitea, githubConnected, projectId, startGiteaDeployPolling]);

  const startDeploymentPolling = useCallback((depId: string) => {
    if (deployPollRef.current) clearInterval(deployPollRef.current);
    setDeploymentStatus('deploying');
    setDeploymentId(depId);

    console.log('🔍 Monitoring deployment:', depId);
    
    deployPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/deployment/current`);
        if (r.status === 404) {
          setDeploymentStatus('idle');
          setDeploymentId(null);
          setPublishLoading(false);
          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }
        if (!r.ok) return;
        const data = await r.json();
        
        // Stop polling if no active deployment (completed)
        if (!data.has_deployment) {
          console.log('🔍 Deployment completed - no active deployment');

          // Set final deployment URL
          if (data.last_deployment_url) {
            const url = String(data.last_deployment_url).startsWith('http') ? data.last_deployment_url : `https://${data.last_deployment_url}`;
            console.log('🔍 Deployment complete! URL:', url);
            setPublishedUrl(url);
            setDeploymentStatus('ready');
          } else {
            setDeploymentStatus('idle');
          }
          
          // End publish loading state (important: release loading even if no deployment)
          setPublishLoading(false);
          
          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }
        
        // If there is an active deployment
        const status = data.status;
        
        // Log only status changes
        if (status && status !== 'QUEUED') {
          console.log('🔍 Deployment status:', status);
        }
        
        // Check if deployment is ready or failed
        const isReady = status === 'READY';
        const isBuilding = status === 'BUILDING' || status === 'QUEUED';
        const isError = status === 'ERROR';
        
        if (isError) {
          console.error('🔍 Deployment failed:', status);
          setDeploymentStatus('error');
          
          // End publish loading state
          setPublishLoading(false);
          
          // Close publish panel after error (with delay to show error message)
          setTimeout(() => {
            setShowPublishPanel(false);
          }, 3000); // Show error for 3 seconds before closing
          
          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
          return;
        }
        
        if (isReady && data.deployment_url) {
          const url = String(data.deployment_url).startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
          console.log('🔍 Deployment complete! URL:', url);
          setPublishedUrl(url);
          setDeploymentStatus('ready');
          
          // End publish loading state
          setPublishLoading(false);
          
          // Keep panel open to show the published URL
          
          if (deployPollRef.current) {
            clearInterval(deployPollRef.current);
            deployPollRef.current = null;
          }
        } else if (isBuilding) {
          setDeploymentStatus('deploying');
        }
      } catch (error) {
        console.error('🔍 Polling error:', error);
      }
    }, 1000); // Changed to 1 second interval
  }, [projectId]);

  const checkCurrentDeployment = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/vercel/deployment/current`);
      if (response.status === 404) {
        return;
      }

      if (response.ok) {
        const data = await response.json();
        if (data.has_deployment) {
          setDeploymentId(data.deployment_id);
          setDeploymentStatus('deploying');
          setPublishLoading(false);
          setShowPublishPanel(true);
          startDeploymentPolling(data.deployment_id);
          console.log('🔍 Resuming deployment monitoring:', data.deployment_id);
        }
      }
    } catch (e) {
      console.warn('Failed to check current deployment', e);
    }
  }, [projectId, startDeploymentPolling]);

  const start = useCallback(async () => {
    try {
      // Fast path: if the dev server is already running, show it immediately
      // (no loading overlay, no artificial delay).
      try {
        const s = await fetch(`${API_BASE}/api/projects/${projectId}/preview/status`, { cache: 'no-store' });
        if (s.ok) {
          const sp = (await s.json())?.data ?? {};
          if (sp.status === 'running' && typeof sp.url === 'string') {
            setPreviewUrl(sp.url);
            setIsStartingPreview(false);
            previewStartFailedRef.current = false;
            return;
          }
        }
      } catch {
        // fall through to a normal (cold) start
      }

      setIsStartingPreview(true);
      setPreviewInitializationMessage('Starting development server…');

      // Heuristic fallback messages for the install phase (before the dev-server
      // process registers, its logs aren't queryable yet).
      const t1 = setTimeout(() => setPreviewInitializationMessage('Installing dependencies…'), 3000);
      const t2 = setTimeout(() => setPreviewInitializationMessage('Building your application…'), 9000);

      // Live progress: poll the preview status and surface the REAL latest
      // dev-server line (e.g. "Nuxt … ready", "Local: …") once it appears, so the
      // 20-30s cold start shows genuine activity instead of a blind spinner.
      const cleanLine = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').replace(/[│─╭╮╰╯]/gu, '').trim();
      const poll = setInterval(async () => {
        try {
          const sr = await fetch(`${API_BASE}/api/projects/${projectId}/preview/status`, { cache: 'no-store' });
          const sj = await sr.json();
          const logs: string[] = sj?.data?.logs ?? [];
          for (let i = logs.length - 1; i >= 0 && i > logs.length - 8; i--) {
            const line = cleanLine(String(logs[i] || ''));
            if (line && /ready|local:|listening|compiled|nuxt|vite|localhost|building|routes|warming/i.test(line)) {
              clearTimeout(t1); clearTimeout(t2);
              setPreviewInitializationMessage(line.slice(0, 90));
              break;
            }
          }
        } catch { /* ignore poll errors */ }
      }, 1500);

      const r = await fetch(`${API_BASE}/api/projects/${projectId}/preview/start`, { method: 'POST' });
      clearTimeout(t1);
      clearTimeout(t2);
      clearInterval(poll);
      if (!r.ok) {
        console.error('Failed to start preview:', r.statusText);
        setPreviewInitializationMessage('Failed to start preview');
        // Don't let the auto-start effect immediately retry in a tight loop.
        previewStartFailedRef.current = true;
        setTimeout(() => setIsStartingPreview(false), 2000);
        return;
      }
      const payload = await r.json();
      const data = payload?.data ?? payload ?? {};

      // Reveal the iframe as soon as the URL is available (no artificial wait).
      setPreviewUrl(typeof data.url === 'string' ? data.url : null);
      setIsStartingPreview(false);
      previewStartFailedRef.current = false;
      setCurrentRoute('/');
    } catch (error) {
      console.error('Error starting preview:', error);
      setPreviewInitializationMessage('An error occurred');
      previewStartFailedRef.current = true;
      setTimeout(() => setIsStartingPreview(false), 2000);
    }
  }, [projectId]);

  // The preview iframe is cross-origin, so it can't be read directly. It reports
  // its current route to us via postMessage (injected claudable-preview plugin);
  // keep the URL bar in sync with in-app navigation.
  useEffect(() => {
    if (!previewUrl) return;
    let previewOrigin: string;
    try { previewOrigin = new URL(previewUrl).origin; } catch { return; }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== previewOrigin) return;
      const data = event.data as { source?: string; path?: string } | null;
      if (data && data.source === 'claudable-preview' && typeof data.path === 'string') {
        setCurrentRoute(data.path.startsWith('/') ? data.path : `/${data.path}`);
        // The plugin has reported in → the (re)loaded page is ready. Flipping this
        // re-fires the renderPins + pending-scroll effects with a live listener,
        // so navigating to a comment shows/scrolls to it on the FIRST click.
        setPreviewReady(true);
        setBridgeAbsent(false); // a report proves the bridge is present
        if (bridgeTimerRef.current) { clearTimeout(bridgeTimerRef.current); bridgeTimerRef.current = null; }
        // Re-arm on EVERY report (dev-server reload, error-overlay refresh,
        // stop→start, idle rebuild) — not just parent-initiated navigation. A
        // freshly (re)loaded plugin starts with pins=[] and no active mode; if we
        // don't re-push here the dots vanish while the mode stays "on" (B2), and
        // edit mode's click-to-select goes dead. Mirrors the share page.
        const win = iframeRef.current?.contentWindow;
        try {
          if (commentModeRef.current) {
            win?.postMessage({ source: 'claudable-comments-cmd', type: 'enter' }, previewOrigin);
            win?.postMessage({
              source: 'claudable-comments-cmd',
              type: 'renderPins',
              activeId: activePinIdRef.current,
              pins: commentsRef.current.map((c) => ({ id: c.id, index: c.index, anchorSelector: c.anchorSelector, relX: c.relX, relY: c.relY, resolved: c.resolved })),
            }, previewOrigin);
          }
          if (editModeRef.current) {
            win?.postMessage({ source: 'claudable-editor-cmd', type: 'enter' }, previewOrigin);
          }
        } catch { /* iframe not ready */ }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewUrl]);

  // --- Visual editor bridge (parent side) ---------------------------------
  const postToPreview = useCallback((msg: Record<string, unknown>) => {
    if (!previewUrl || !iframeRef.current?.contentWindow) return;
    try {
      iframeRef.current.contentWindow.postMessage({ source: 'claudable-editor-cmd', ...msg }, new URL(previewUrl).origin);
    } catch { /* iframe not ready */ }
  }, [previewUrl]);

  // Toggle the preview into/out of click-to-select edit mode.
  useEffect(() => {
    postToPreview({ type: editMode ? 'enter' : 'exit' });
    if (editMode) setCommentMode(false); // edit + comment modes are mutually exclusive
    if (!editMode) { setSelectedEl(null); setStyleEdits({}); setTextEdit(null); }
  }, [editMode, postToPreview]);

  // Receive the selected element from the preview editor bridge.
  useEffect(() => {
    if (!previewUrl) return;
    let origin: string;
    try { origin = new URL(previewUrl).origin; } catch { return; }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const d = e.data as { source?: string; type?: string; element?: SelectedElement } | null;
      if (d?.source === 'claudable-editor' && d.type === 'selected' && d.element) {
        setSelectedEl(d.element);
        setStyleEdits({});
        setTextEdit(null);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [previewUrl]);

  const applyStyle = useCallback((prop: string, value: string) => {
    setStyleEdits((prev) => ({ ...prev, [prop]: value }));
    postToPreview({ type: 'applyStyle', prop, value });
  }, [postToPreview]);

  const applyText = useCallback((value: string) => {
    setTextEdit(value);
    postToPreview({ type: 'applyText', value });
  }, [postToPreview]);

  const persistEdits = useCallback(async () => {
    if (!selectedEl) return;
    // "Apply to code" launches an agent turn — refuse while one is running so it
    // doesn't race (the server would 409 anyway). The button is also disabled.
    if (hasActiveRequests) return;
    const styleLines = Object.entries(styleEdits).map(([k, v]) => `  - ${k}: ${v}`);
    const instruction = [
      `Visual edit — persist these preview-only changes into the source code:`,
      ``,
      `Element: <${selectedEl.tag}>${selectedEl.id ? ` #${selectedEl.id}` : ''}${selectedEl.classes.length ? ` .${selectedEl.classes.join('.')}` : ''}`,
      `CSS selector: ${selectedEl.selector}`,
      selectedEl.text ? `Current text: "${selectedEl.text.slice(0, 100)}"` : '',
      textEdit !== null && textEdit !== selectedEl.text ? `New text: "${textEdit}"` : '',
      styleLines.length ? `Style changes:\n${styleLines.join('\n')}` : '',
      ``,
      `Locate this element in the source (match the selector / tag / classes) and apply the change idiomatically — prefer Tailwind classes or scoped styles as fits the codebase. Keep the diff minimal.`,
    ].filter(Boolean).join('\n');
    setPersistingEdit(true);
    try {
      // Always call the LATEST runAct (a fresh closure each render) via a ref, so
      // the persisted edit uses the current model/mode — not a stale captured one.
      await runActRef.current?.(instruction, []);
      setStyleEdits({});
      setTextEdit(null);
      setEditMode(false);
    } finally {
      setPersistingEdit(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEl, styleEdits, textEdit]);

  // --- Comments (pinned review annotations, Claudable-only) -----------------
  const postComments = useCallback((msg: Record<string, unknown>) => {
    if (!previewUrl || !iframeRef.current?.contentWindow) return;
    try { iframeRef.current.contentWindow.postMessage({ source: 'claudable-comments-cmd', ...msg }, new URL(previewUrl).origin); } catch { /* not ready */ }
  }, [previewUrl]);

  const loadComments = useCallback(async (route: string) => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/comments?route=${encodeURIComponent(route)}`);
      const j = await r.json();
      if (j.success) setComments((j.data as any[]).map((c, i) => ({ ...c, index: i + 1 })));
    } catch { /* ignore */ }
  }, [projectId]);

  // ALL comments across every route (powers the overview list). Omitting `route`
  // returns the whole project's comments.
  const loadAllComments = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/comments`);
      const j = await r.json();
      if (j.success) setAllComments(j.data as (CommentPin & { route: string })[]);
    } catch { /* ignore */ }
  }, [projectId]);

  // Jump to a comment: switch route if needed (the preview reloads and its pins
  // reload), then scroll to + highlight the anchor. Same-route jumps are instant.
  const goToComment = useCallback((c: CommentPin & { route: string }) => {
    const route = c.route || '/';
    setShowPreview(true);
    if (!commentMode) setCommentMode(true);
    if (route !== (currentRouteRef.current || '/')) {
      pendingScrollRef.current = { id: c.id, anchorSelector: c.anchorSelector, route };
      navigateToRoute(route);
    } else {
      setActivePinId(c.id);
      postComments({ type: 'scrollTo', anchorSelector: c.anchorSelector });
    }
  }, [commentMode, postComments]);

  // Enter/exit comment mode (mutually exclusive with edit mode).
  useEffect(() => {
    postComments({ type: commentMode ? 'enter' : 'exit' });
    if (commentMode) { setEditMode(false); loadComments(currentRouteRef.current || '/'); }
    else {
      setComposeAnchor(null); setActivePinId(null); setShowCommentsList(false);
      // Wipe the in-iframe pin dots — otherwise they linger with pointer-events
      // and swallow clicks while browsing / get selected in edit mode (B6).
      postComments({ type: 'renderPins', pins: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentMode, postComments]);

  // Reload the pin set when the previewed route changes while commenting.
  useEffect(() => {
    if (!commentMode) return;
    // Clear stale pins/positions so the old route's dots don't flash on the new page.
    setActivePinId(null); setComposeAnchor(null); setComments([]); setPinPositions({});
    loadComments(currentRoute || '/');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoute]);

  // Push the current pins to the in-iframe bridge whenever they change OR once
  // the (re)loaded preview reports ready — so pins land even after a navigation.
  useEffect(() => {
    if (!commentMode || !previewReady) return;
    postComments({ type: 'renderPins', activeId: activePinId, pins: comments.map((c) => ({ id: c.id, index: c.index, anchorSelector: c.anchorSelector, relX: c.relX, relY: c.relY, resolved: c.resolved })) });
  }, [comments, activePinId, commentMode, previewReady, postComments]);

  // After navigating to another route for goToComment, wait until the preview is
  // ready AND that route's comments have loaded (the pin exists), then scroll to
  // + activate it. Gating on previewReady is what makes the FIRST click work.
  useEffect(() => {
    const p = pendingScrollRef.current;
    if (!p || !previewReady || (currentRoute || '/') !== (p.route || '/')) return;
    if (!comments.some((c) => c.id === p.id)) return; // pins for the new route not loaded yet
    pendingScrollRef.current = null;
    setActivePinId(p.id);
    const t = setTimeout(() => postComments({ type: 'scrollTo', anchorSelector: p.anchorSelector }), 250);
    return () => clearTimeout(t);
  }, [comments, currentRoute, previewReady, postComments]);

  // Keep the overview list fresh: reload it when open, or when the current
  // route's comments change (add/resolve/delete) while it's open.
  useEffect(() => {
    if (showCommentsList) loadAllComments();
  }, [showCommentsList, comments, loadAllComments]);

  // Receive events from the comments bridge.
  useEffect(() => {
    if (!previewUrl) return;
    let origin: string;
    try { origin = new URL(previewUrl).origin; } catch { return; }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const d = e.data as any;
      if (!d || d.source !== 'claudable-comments') return;
      if (d.type === 'placed') { setActivePinId(null); setComposeAnchor({ anchorSelector: d.anchorSelector, relX: d.relX, relY: d.relY, x: d.x, y: d.y }); }
      else if (d.type === 'pinPositions') { const m: Record<string, { x: number | null; y: number | null }> = {}; (d.positions || []).forEach((p: any) => { m[p.id] = { x: p.x, y: p.y }; }); setPinPositions(m); }
      else if (d.type === 'pinClicked') { setComposeAnchor(null); setActivePinId(d.id); }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [previewUrl]);

  // Collect runtime errors the preview reports (deduped, capped).
  useEffect(() => {
    if (!previewUrl) return;
    let origin: string;
    try { origin = new URL(previewUrl).origin; } catch { return; }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const d = e.data as any;
      if (d?.source === 'claudable-errors' && d.type === 'error' && d.error?.message) {
        setPreviewErrors((prev) => (prev.some((x) => x.message === d.error.message) ? prev : [...prev.slice(-9), d.error]));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [previewUrl]);
  // Clear on route change or when a new turn starts (errors get re-reported if still present).
  useEffect(() => { setPreviewErrors([]); }, [currentRoute]);
  useEffect(() => { if (hasActiveRequests) setPreviewErrors([]); }, [hasActiveRequests]);

  const fixPreviewErrors = useCallback(() => {
    if (!previewErrors.length) return;
    const list = previewErrors.map((e, i) => `${i + 1}. [${e.kind}] ${e.message}${e.at ? ` (${e.at})` : ''}`).join('\n');
    const instruction = `The live preview is throwing these runtime errors on route "${currentRouteRef.current || '/'}":\n\n${list}\n\nFind the cause in the source and fix it. Keep the change minimal and don't introduce new behavior.`;
    setPreviewErrors([]);
    runActRef.current?.(instruction, []);
  }, [previewErrors]);

  const submitNewComment = useCallback(async (body: string): Promise<boolean> => {
    if (!composeAnchor) return false;
    const route = currentRoute || '/';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ route, anchorSelector: composeAnchor.anchorSelector, relX: composeAnchor.relX, relY: composeAnchor.relY, body }),
      });
      const j = await r.json().catch(() => null);
      if (j?.success) { setComposeAnchor(null); await loadComments(route); return true; }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }, [composeAnchor, currentRoute, projectId, loadComments]);

  const resolveCommentById = useCallback(async (id: string, resolved: boolean) => {
    await fetch(`${API_BASE}/api/projects/${projectId}/comments/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolved }) }).catch(() => {});
    await loadComments(currentRoute || '/');
  }, [projectId, currentRoute, loadComments]);

  const deleteCommentById = useCallback(async (id: string) => {
    await fetch(`${API_BASE}/api/projects/${projectId}/comments/${id}`, { method: 'DELETE' }).catch(() => {});
    setActivePinId(null);
    await loadComments(currentRoute || '/');
  }, [projectId, currentRoute, loadComments]);

  const clearAllComments = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm('Delete ALL comments in this project (every route)?')) return;
    await fetch(`${API_BASE}/api/projects/${projectId}/comments`, { method: 'DELETE' }).catch(() => {});
    setActivePinId(null); setComposeAnchor(null);
    await loadComments(currentRoute || '/');
  }, [projectId, currentRoute, loadComments]);

  // Create (or reuse) a public review link and copy it to the clipboard.
  const shareReviewLink = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/share`, { method: 'POST' });
      const j = await res.json();
      if (!j.success || !j.data?.token) throw new Error(j.message || 'Could not create share link');
      const link = `${window.location.origin}/share/${j.data.token}`;
      try {
        await navigator.clipboard.writeText(link);
        toast.success('Review link copied to clipboard');
      } catch {
        toast.info(`Review link: ${link}`);
      }
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create share link');
    }
  }, [projectId, toast]);

  // --- Device frame fit-scaling: keep any device frame inside the pane ---
  const currentDevice = DEVICE_PRESETS.find((d) => d.id === deviceId) ?? DEVICE_PRESETS[0];
  const deviceDims = currentDevice.desktop
    ? null
    : orientation === 'landscape'
      ? { w: currentDevice.h!, h: currentDevice.w! }
      : { w: currentDevice.w!, h: currentDevice.h! };
  const ddW = deviceDims?.w ?? 0;
  const ddH = deviceDims?.h ?? 0;
  useEffect(() => {
    // Re-run on previewUrl change: the observed element only mounts once the
    // preview is up, so without previewUrl in deps the observer would never attach.
    const el = deviceViewportRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth, h = el.clientHeight;
      setDeviceViewport({ w, h });
      if (!ddW || !ddH) { setDeviceScale(1); return; }
      const pad = 32; // breathing room around the frame
      const s = Math.min(1, (w - pad) / ddW, (h - pad) / ddH);
      setDeviceScale(s > 0 ? s : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ddW, ddH, previewUrl]);

  // Convert iframe-space pin coords to CONTAINER (screen) coords, accounting for
  // the centered, scaled device frame. This lets the comment popovers live OUTSIDE
  // the scaled frame (so they render full-size and aren't clipped) while staying
  // aligned with the pin dots inside the iframe.
  const toScreen = useCallback((x: number, y: number) => {
    if (!ddW || !ddH) return { x, y }; // desktop: iframe fills the container 1:1
    const frameLeft = deviceViewport.w / 2 - (ddW * deviceScale) / 2;
    const frameTop = deviceViewport.h / 2 - (ddH * deviceScale) / 2;
    return { x: frameLeft + x * deviceScale, y: frameTop + y * deviceScale };
  }, [ddW, ddH, deviceViewport.w, deviceViewport.h, deviceScale]);
  const screenPinPositions = useMemo(() => {
    const out: Record<string, { x: number | null; y: number | null }> = {};
    for (const [id, p] of Object.entries(pinPositions)) {
      out[id] = p.x == null || p.y == null ? { x: null, y: null } : toScreen(p.x, p.y);
    }
    return out;
  }, [pinPositions, toScreen]);
  const screenCompose = useMemo(() => (composeAnchor ? { ...composeAnchor, ...toScreen(composeAnchor.x, composeAnchor.y) } : null), [composeAnchor, toScreen]);

  // Keep-warm heartbeat: while a preview is open, ping its status every few
  // minutes so the server-side idle sweep doesn't evict an actively-viewed
  // preview (the status read refreshes its lastAccessedAt). Also ping the moment
  // the tab is refocused — background tabs get their timers throttled/frozen, so
  // this both resets the idle clock on return AND proactively rebuilds a preview
  // that was already evicted, so it's warming while you look at it.
  useEffect(() => {
    if (!previewUrl) return;
    const ping = () => {
      fetch(`${API_BASE}/api/projects/${projectId}/preview/status`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const st = j?.data?.status;
          if (st && st !== 'running' && st !== 'starting') start(); // evicted → rebuild now
        })
        .catch(() => {});
    };
    const id = setInterval(ping, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') ping(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [previewUrl, projectId, start]);

  // Navigate to specific route in iframe
  const navigateToRoute = (route: string) => {
    if (previewUrl && iframeRef.current) {
      const baseUrl = previewUrl.split('?')[0]; // Remove any query params
      // Ensure route starts with /
      const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
      const newUrl = `${baseUrl}${normalizedRoute}`;
      setPreviewReady(false); // the new page's plugin hasn't reported yet
      setBridgeAbsent(false);
      iframeRef.current.src = newUrl;
      setCurrentRoute(normalizedRoute);
    }
  };

  const refreshPreview = useCallback(() => {
    if (!previewUrl || !iframeRef.current) {
      return;
    }

    try {
      const normalizedRoute =
        currentRoute && currentRoute.startsWith('/')
          ? currentRoute
          : `/${currentRoute || ''}`;
      const baseUrl = previewUrl.split('?')[0] || previewUrl;
      const url = new URL(baseUrl + normalizedRoute);
      url.searchParams.set('_ts', Date.now().toString());
      setPreviewReady(false); // wait for the reloaded page's plugin to report before pushing pins
      setBridgeAbsent(false);
      iframeRef.current.src = url.toString();
    } catch (error) {
      console.warn('Failed to refresh preview iframe:', error);
    }
  }, [previewUrl, currentRoute]);


  const stop = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/projects/${projectId}/preview/stop`, { method: 'POST' });
      setPreviewUrl(null);
    } catch (error) {
      console.error('Error stopping preview:', error);
    }
  }, [projectId]);

  const loadSubdirectory = useCallback(async (dir: string): Promise<Entry[]> => {
    try {
      const r = await fetch(`${API_BASE}/api/repo/${projectId}/tree?dir=${encodeURIComponent(dir)}`);
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('Failed to load subdirectory:', error);
      return [];
    }
  }, [projectId]);

  const loadTree = useCallback(async (dir = '.') => {
    try {
      const r = await fetch(`${API_BASE}/api/repo/${projectId}/tree?dir=${encodeURIComponent(dir)}`);
      const data = await r.json();
      
      // Ensure data is an array
      if (Array.isArray(data)) {
        setTree(data);
        
        // Load contents for all directories in the root
        const newFolderContents = new Map();
        
        // Process each directory
        for (const entry of data) {
          if (entry.type === 'dir') {
            try {
              const subContents = await loadSubdirectory(entry.path);
              newFolderContents.set(entry.path, subContents);
            } catch (err) {
              console.error(`Failed to load contents for ${entry.path}:`, err);
            }
          }
        }
        
        setFolderContents(newFolderContents);
      } else {
        console.error('Tree data is not an array:', data);
        setTree([]);
      }
      
      setCurrentPath(dir);
    } catch (error) {
      console.error('Failed to load tree:', error);
      setTree([]);
    }
  }, [projectId, loadSubdirectory]);

  // Load subdirectory contents

  // Load folder contents
  const handleLoadFolder = useCallback(async (path: string) => {
    const contents = await loadSubdirectory(path);
    setFolderContents(prev => {
      const newMap = new Map(prev);
      newMap.set(path, contents);
      
      // Also load nested directories
      for (const entry of contents) {
        if (entry.type === 'dir') {
          const fullPath = `${path}/${entry.path}`;
          // Don't load if already loaded
          if (!newMap.has(fullPath)) {
            loadSubdirectory(fullPath).then(subContents => {
              setFolderContents(prev2 => new Map(prev2).set(fullPath, subContents));
            });
          }
        }
      }
      
      return newMap;
    });
  }, [loadSubdirectory]);

  // Toggle folder expansion
  function toggleFolder(path: string) {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  }

  // Build tree structure from flat list
  function buildTreeStructure(entries: Entry[]): Map<string, Entry[]> {
    const structure = new Map<string, Entry[]>();
    
    // Initialize with root
    structure.set('', []);
    
    entries.forEach(entry => {
      const parts = entry.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      
      if (!structure.has(parentPath)) {
        structure.set(parentPath, []);
      }
      structure.get(parentPath)?.push(entry);
      
      // If it's a directory, ensure it exists in the structure
      if (entry.type === 'dir') {
        if (!structure.has(entry.path)) {
          structure.set(entry.path, []);
        }
      }
    });
    
    return structure;
  }

  const openFile = useCallback(async (path: string) => {
    try {
      if (hasUnsavedChanges && path !== selectedFile) {
        const shouldDiscard =
          typeof window !== 'undefined'
            ? window.confirm('You have unsaved changes. Discard them and open the new file?')
            : true;
        if (!shouldDiscard) {
          return;
        }
      }

      setSaveFeedback('idle');
      setSaveError(null);

      const r = await fetch(`${API_BASE}/api/repo/${projectId}/file?path=${encodeURIComponent(path)}`);
      
      if (!r.ok) {
        console.error('Failed to load file:', r.status, r.statusText);
        const fallback = '// Failed to load file content';
        setContent(fallback);
        setEditedContent(fallback);
        editedContentRef.current = fallback;
        setHasUnsavedChanges(false);
        setSelectedFile(path);
        return;
      }
      
      const data = await r.json();
      const fileContent = typeof data?.content === 'string' ? data.content : '';
      setContent(fileContent);
      setEditedContent(fileContent);
      editedContentRef.current = fileContent;
      setHasUnsavedChanges(false);
      setSelectedFile(path);
      setIsFileUpdating(false);

      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.scrollTop = 0;
          editorRef.current.scrollLeft = 0;
        }
        if (highlightRef.current) {
          highlightRef.current.scrollTop = 0;
          highlightRef.current.scrollLeft = 0;
        }
        if (lineNumberRef.current) {
          lineNumberRef.current.scrollTop = 0;
        }
      });
    } catch (error) {
      console.error('Error opening file:', error);
      const fallback = '// Error loading file';
      setContent(fallback);
      setEditedContent(fallback);
      editedContentRef.current = fallback;
      setHasUnsavedChanges(false);
      setSelectedFile(path);
    }
  }, [projectId, hasUnsavedChanges, selectedFile]);

  // Reload currently selected file
  const reloadCurrentFile = useCallback(async () => {
    if (selectedFile && !showPreview && !hasUnsavedChanges) {
      try {
        const r = await fetch(`${API_BASE}/api/repo/${projectId}/file?path=${encodeURIComponent(selectedFile)}`);
        if (r.ok) {
          const data = await r.json();
          const newContent = data.content || '';
          if (newContent !== content) {
            setIsFileUpdating(true);
            setContent(newContent);
            setEditedContent(newContent);
            editedContentRef.current = newContent;
            setHasUnsavedChanges(false);
            setSaveFeedback('idle');
            setSaveError(null);
            setTimeout(() => setIsFileUpdating(false), 500);
          }
        }
      } catch (error) {
        // Silently fail - this is a background refresh
      }
    }
  }, [projectId, selectedFile, showPreview, hasUnsavedChanges, content]);

  // Lazy load highlight.js only when needed
  const [hljs, setHljs] = useState<any>(null);
  
  useEffect(() => {
    if (selectedFile && !hljs) {
      import('highlight.js/lib/common').then(mod => {
        setHljs(mod.default);
        // Load highlight.js CSS dynamically
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css';
        document.head.appendChild(link);
      });
    }
  }, [selectedFile, hljs]);

  const highlightedCode = useMemo(() => {
    const code = editedContent ?? '';
    if (!code) {
      return '&nbsp;';
    }

    if (!hljs) {
      return escapeHtml(code);
    }

    const language = getFileLanguage(selectedFile);
    try {
      if (!language || language === 'plaintext') {
        return escapeHtml(code);
      }
      return hljs.highlight(code, { language }).value;
    } catch {
      try {
        return hljs.highlightAuto(code).value;
      } catch {
        return escapeHtml(code);
      }
    }
  }, [hljs, editedContent, selectedFile]);

  const onEditorChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setEditedContent(value);
    editedContentRef.current = value;
    setHasUnsavedChanges(value !== content);
    setSaveFeedback('idle');
    setSaveError(null);
    if (isFileUpdating) {
      setIsFileUpdating(false);
    }
  }, [content, isFileUpdating]);

  const handleEditorScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
    if (lineNumberRef.current) {
      lineNumberRef.current.scrollTop = scrollTop;
    }
  }, []);

  const handleSaveFile = useCallback(async () => {
    if (!selectedFile || isSavingFile || !hasUnsavedChanges) {
      return;
    }

    const contentToSave = editedContentRef.current;
    setIsSavingFile(true);
    setSaveFeedback('idle');
    setSaveError(null);

    try {
      const response = await fetch(`${API_BASE}/api/repo/${projectId}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: contentToSave }),
      });

      if (!response.ok) {
        let errorMessage = 'Failed to save file';
        try {
          const data = await response.clone().json();
          errorMessage = data?.error || data?.message || errorMessage;
        } catch {
          const text = await response.text().catch(() => '');
          if (text) {
            errorMessage = text;
          }
        }
        throw new Error(errorMessage);
      }

      setContent(contentToSave);
      setSaveFeedback('success');

      if (editedContentRef.current === contentToSave) {
        setHasUnsavedChanges(false);
        setIsFileUpdating(true);
        setTimeout(() => setIsFileUpdating(false), 800);
      }

      refreshPreview();
    } catch (error) {
      console.error('Failed to save file:', error);
      setSaveFeedback('error');
      setSaveError(error instanceof Error ? error.message : 'Failed to save file');
    } finally {
      setIsSavingFile(false);
    }
  }, [selectedFile, isSavingFile, hasUnsavedChanges, projectId, refreshPreview]);

  const handleEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      handleSaveFile();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const indent = '  ';
      const value = editedContent;
      const newValue = value.slice(0, start) + indent + value.slice(end);

      setEditedContent(newValue);
      editedContentRef.current = newValue;
      setHasUnsavedChanges(newValue !== content);
      setSaveFeedback('idle');
      setSaveError(null);
      if (isFileUpdating) {
        setIsFileUpdating(false);
      }

      requestAnimationFrame(() => {
        const position = start + indent.length;
        el.selectionStart = position;
        el.selectionEnd = position;
        if (highlightRef.current) {
          highlightRef.current.scrollTop = el.scrollTop;
          highlightRef.current.scrollLeft = el.scrollLeft;
        }
        if (lineNumberRef.current) {
          lineNumberRef.current.scrollTop = el.scrollTop;
        }
      });
    }
  }, [handleSaveFile, editedContent, content, isFileUpdating]);

  useEffect(() => {
    if (saveFeedback === 'success') {
      const timer = setTimeout(() => setSaveFeedback('idle'), 1800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [saveFeedback]);

  useEffect(() => {
    if (editorRef.current && highlightRef.current && lineNumberRef.current) {
      const { scrollTop, scrollLeft } = editorRef.current;
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
      lineNumberRef.current.scrollTop = scrollTop;
    }
  }, [editedContent]);

  // Get file extension for syntax highlighting
  // getFileLanguage / escapeHtml now live in @/lib/utils/format (tested).

  // Get file icon based on type
  function getFileIcon(entry: Entry): React.ReactElement {
    if (entry.type === 'dir') {
      return <span className="text-blue-500"><FaFolder size={16} /></span>;
    }
    
    const ext = entry.path.split('.').pop()?.toLowerCase();
    const filename = entry.path.split('/').pop()?.toLowerCase();
    
    // Special files
    if (filename === 'package.json') return <span className="text-green-600"><VscJson size={16} /></span>;
    if (filename === 'dockerfile') return <span className="text-blue-400"><FaDocker size={16} /></span>;
    if (filename?.startsWith('.env')) return <span className="text-yellow-500"><FaLock size={16} /></span>;
    if (filename === 'readme.md') return <span className="text-gray-600 dark:text-gray-300"><FaMarkdown size={16} /></span>;
    if (filename?.includes('config')) return <span className="text-gray-500 dark:text-gray-400"><FaCog size={16} /></span>;
    
    switch (ext) {
      case 'tsx':
        return <span className="text-cyan-400"><FaReact size={16} /></span>;
      case 'ts':
        return <span className="text-blue-600"><SiTypescript size={16} /></span>;
      case 'jsx':
        return <span className="text-cyan-400"><FaReact size={16} /></span>;
      case 'js':
      case 'mjs':
        return <span className="text-yellow-400"><FaJs size={16} /></span>;
      case 'css':
        return <span className="text-blue-500"><FaCss3Alt size={16} /></span>;
      case 'scss':
      case 'sass':
        return <span className="text-pink-500"><FaCss3Alt size={16} /></span>;
      case 'html':
      case 'htm':
        return <span className="text-orange-500"><FaHtml5 size={16} /></span>;
      case 'json':
        return <span className="text-yellow-600"><VscJson size={16} /></span>;
      case 'md':
      case 'markdown':
        return <span className="text-gray-600 dark:text-gray-300"><FaMarkdown size={16} /></span>;
      case 'py':
        return <span className="text-blue-400"><FaPython size={16} /></span>;
      case 'sh':
      case 'bash':
        return <span className="text-green-500"><FaFileCode size={16} /></span>;
      case 'yaml':
      case 'yml':
        return <span className="text-red-500"><SiYaml size={16} /></span>;
      case 'xml':
        return <span className="text-orange-600"><FaFileCode size={16} /></span>;
      case 'sql':
        return <span className="text-blue-600"><FaDatabase size={16} /></span>;
      case 'php':
        return <span className="text-indigo-500"><FaPhp size={16} /></span>;
      case 'java':
        return <span className="text-red-600"><FaJava size={16} /></span>;
      case 'c':
        return <span className="text-blue-700"><FaFileCode size={16} /></span>;
      case 'cpp':
      case 'cc':
      case 'cxx':
        return <span className="text-blue-600"><SiCplusplus size={16} /></span>;
      case 'rs':
        return <span className="text-orange-700"><FaRust size={16} /></span>;
      case 'go':
        return <span className="text-cyan-500"><SiGo size={16} /></span>;
      case 'rb':
        return <span className="text-red-500"><SiRuby size={16} /></span>;
      case 'vue':
        return <span className="text-green-500"><FaVuejs size={16} /></span>;
      case 'svelte':
        return <span className="text-orange-600"><SiSvelte size={16} /></span>;
      case 'dockerfile':
        return <span className="text-blue-400"><FaDocker size={16} /></span>;
      case 'toml':
      case 'ini':
      case 'conf':
      case 'config':
        return <span className="text-gray-500 dark:text-gray-400"><FaCog size={16} /></span>;
      default:
        return <span className="text-gray-400 dark:text-gray-500"><FaFile size={16} /></span>;
    }
  }

  // Ensure we only trigger dependency installation once per page lifecycle
  const installTriggeredRef = useRef(false);

  const startDependencyInstallation = useCallback(async () => {
    if (installTriggeredRef.current) {
      return;
    }
    installTriggeredRef.current = true;
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/install-dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('⚠️ Failed to start dependency installation:', errorText);
        // allow retry on next attempt if initial trigger failed
        installTriggeredRef.current = false;
      }
    } catch (error) {
      console.error('❌ Error starting dependency installation:', error);
      // allow retry if network error
      installTriggeredRef.current = false;
    }
  }, [projectId]);

  const loadSettings = useCallback(async (projectSettings?: { cli?: string; model?: string }) => {
    try {
      console.log('🔧 loadSettings called with project settings:', projectSettings);

      const hasCliSet = projectSettings?.cli || preferredCli;
      const hasModelSet = projectSettings?.model || selectedModel;

      if (!hasCliSet || !hasModelSet) {
        console.log('⚠️ Missing CLI or model, loading global settings');
        const globalResponse = await fetch(`${API_BASE}/api/settings/global`);
        if (globalResponse.ok) {
          const globalSettings = await globalResponse.json();
          const defaultCli = sanitizeCli(globalSettings.default_cli || globalSettings.defaultCli);
          const cliToUse = sanitizeCli(hasCliSet || defaultCli);

          if (!hasCliSet) {
            console.log('🔄 Setting CLI from global:', cliToUse);
            updatePreferredCli(cliToUse);
          }

          if (!hasModelSet) {
            const cliSettings = globalSettings.cli_settings?.[cliToUse] || globalSettings.cliSettings?.[cliToUse];
            if (cliSettings?.model) {
              updateSelectedModel(cliSettings.model, cliToUse);
            } else {
              updateSelectedModel(getDefaultModelForCli(cliToUse), cliToUse);
            }
          }
        } else {
          const response = await fetch(`${API_BASE}/api/settings`);
          if (response.ok) {
            const settings = await response.json();
            if (!hasCliSet) updatePreferredCli(settings.preferred_cli || settings.default_cli || DEFAULT_ACTIVE_CLI);
            if (!hasModelSet) {
              const cli = sanitizeCli(settings.preferred_cli || settings.default_cli || preferredCli || DEFAULT_ACTIVE_CLI);
              updateSelectedModel(getDefaultModelForCli(cli), cli);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      const hasCliSet = projectSettings?.cli || preferredCli;
      const hasModelSet = projectSettings?.model || selectedModel;
      if (!hasCliSet) updatePreferredCli(DEFAULT_ACTIVE_CLI);
      if (!hasModelSet) updateSelectedModel(getDefaultModelForCli(DEFAULT_ACTIVE_CLI), DEFAULT_ACTIVE_CLI);
    }
  }, [preferredCli, selectedModel, updatePreferredCli, updateSelectedModel]);

  const loadProjectInfo = useCallback(async (): Promise<{ cli?: string; model?: string; status?: ProjectStatus }> => {
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}`);
      if (!r.ok) {
        setProjectName(`Project ${projectId.slice(0, 8)}`);
        setProjectDescription('');
        setHasInitialPrompt(false);
        localStorage.setItem(`project_${projectId}_hasInitialPrompt`, 'false');
        setProjectStatus('active');
        setIsInitializing(false);
        setUsingGlobalDefaults(true);
        return {};
      }

      const payload = await r.json();
      const project = payload?.data ?? payload;
      const rawPreferredCli =
        typeof project?.preferredCli === 'string'
          ? project.preferredCli
          : typeof project?.preferred_cli === 'string'
          ? project.preferred_cli
          : undefined;
      const rawSelectedModel =
        typeof project?.selectedModel === 'string'
          ? project.selectedModel
          : typeof project?.selected_model === 'string'
          ? project.selected_model
          : undefined;

      console.log('📋 Loading project info:', {
        preferredCli: rawPreferredCli,
        selectedModel: rawSelectedModel,
      });

      setProjectName(project.name || `Project ${projectId.slice(0, 8)}`);

      const projectCli = sanitizeCli(rawPreferredCli || preferredCli);
      if (rawPreferredCli) {
        updatePreferredCli(projectCli);
      }
      if (rawSelectedModel) {
        updateSelectedModel(rawSelectedModel, projectCli);
      } else {
        updateSelectedModel(getDefaultModelForCli(projectCli), projectCli);
      }

      const followGlobal = !rawPreferredCli && !rawSelectedModel;
      setUsingGlobalDefaults(followGlobal);
      setProjectDescription(project.description || '');

      if (project.initial_prompt) {
        setHasInitialPrompt(true);
        localStorage.setItem(`project_${projectId}_hasInitialPrompt`, 'true');
      } else {
        setHasInitialPrompt(false);
        localStorage.setItem(`project_${projectId}_hasInitialPrompt`, 'false');
      }

      if (project.status === 'initializing') {
        setProjectStatus('initializing');
        setIsInitializing(true);
      } else {
        setProjectStatus('active');
        setIsInitializing(false);
        startDependencyInstallation();
        triggerInitialPromptIfNeeded();
      }

      const normalizedModel = rawSelectedModel
        ? sanitizeModel(projectCli, rawSelectedModel)
        : getDefaultModelForCli(projectCli);

      return {
        cli: rawPreferredCli ? projectCli : undefined,
        model: normalizedModel,
        status: project.status as ProjectStatus | undefined,
      };
    } catch (error) {
      console.error('Failed to load project info:', error);
      setProjectName(`Project ${projectId.slice(0, 8)}`);
      setProjectDescription('');
      setHasInitialPrompt(false);
      localStorage.setItem(`project_${projectId}_hasInitialPrompt`, 'false');
      setProjectStatus('active');
      setIsInitializing(false);
      setUsingGlobalDefaults(true);
      return {};
    }
  }, [
    projectId,
    startDependencyInstallation,
    triggerInitialPromptIfNeeded,
    updatePreferredCli,
    updateSelectedModel,
    preferredCli,
  ]);

  const loadProjectInfoRef = useRef(loadProjectInfo);
  useEffect(() => {
    loadProjectInfoRef.current = loadProjectInfo;
  }, [loadProjectInfo]);

  useEffect(() => {
    if (!searchParams) return;
    const cliParam = searchParams.get('cli');
    const modelParam = searchParams.get('model');
    if (!cliParam && !modelParam) {
      return;
    }
    const sanitizedCli = cliParam ? sanitizeCli(cliParam) : preferredCli;
    if (cliParam) {
      setUsingGlobalDefaults(false);
      updatePreferredCli(sanitizedCli);
    }
    if (modelParam) {
      setUsingGlobalDefaults(false);
      updateSelectedModel(modelParam, sanitizedCli);
    }
  }, [searchParams, preferredCli, updatePreferredCli, updateSelectedModel, setUsingGlobalDefaults]);

  const loadSettingsRef = useRef(loadSettings);
  useEffect(() => {
    loadSettingsRef.current = loadSettings;
  }, [loadSettings]);

  const loadTreeRef = useRef(loadTree);
  useEffect(() => {
    loadTreeRef.current = loadTree;
  }, [loadTree]);

  const loadDeployStatusRef = useRef(loadDeployStatus);
  useEffect(() => {
    loadDeployStatusRef.current = loadDeployStatus;
  }, [loadDeployStatus]);

  const checkCurrentDeploymentRef = useRef(checkCurrentDeployment);
  useEffect(() => {
    checkCurrentDeploymentRef.current = checkCurrentDeployment;
  }, [checkCurrentDeployment]);

  // Stable message handlers with useCallback to prevent reassignment
  const createStableMessageHandlers = useCallback(() => {
    const addMessage = (message: any) => {
      console.log('🔄 [StableHandler] Adding message via stable handler:', {
        messageId: message.id,
        role: message.role,
        isOptimistic: message.isOptimistic,
        requestId: message.requestId
      });

      // Track optimistic messages by requestId
      if (message.isOptimistic && message.requestId) {
        optimisticMessagesRef.current.set(message.requestId, message);
        console.log('🔄 [StableHandler] Tracking optimistic message:', {
          requestId: message.requestId,
          tempId: message.id
        });
      }

      // Also call the current handlers if they exist
      if (messageHandlersRef.current) {
        messageHandlersRef.current.add(message);
      }
    };

    const removeMessage = (messageId: string) => {
      console.log('🔄 [StableHandler] Removing message via stable handler:', messageId);

      // Remove from optimistic messages tracking if it's an optimistic message
      const optimisticMessage = Array.from(optimisticMessagesRef.current.values())
        .find(msg => msg.id === messageId);
      if (optimisticMessage && optimisticMessage.requestId) {
        optimisticMessagesRef.current.delete(optimisticMessage.requestId);
        console.log('🔄 [StableHandler] Removed optimistic message tracking:', {
          requestId: optimisticMessage.requestId,
          tempId: messageId
        });
      }

      // Also call the current handlers if they exist
      if (messageHandlersRef.current) {
        messageHandlersRef.current.remove(messageId);
      }
    };

    return { add: addMessage, remove: removeMessage };
  }, []);

  // Initialize stable handlers once
  useEffect(() => {
    stableMessageHandlers.current = createStableMessageHandlers();
    const optimisticMessages = optimisticMessagesRef.current;

    return () => {
      stableMessageHandlers.current = null;
      optimisticMessages.clear();
    };
  }, [createStableMessageHandlers]);

  // Handle image upload with base64 conversion
  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        if (file.type.startsWith('image/')) {
          const url = URL.createObjectURL(file);
          
          // Convert to base64
          const reader = new FileReader();
          reader.onload = (e) => {
            const base64 = e.target?.result as string;
            setUploadedImages(prev => [...prev, {
              name: file.name,
              url,
              base64
            }]);
          };
          reader.readAsDataURL(file);
        }
      });
    }
  };

  // Remove uploaded image
  const removeUploadedImage = (index: number) => {
    setUploadedImages(prev => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].url);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  runActRef.current = (m, i) => runAct(m, i);
  currentRouteRef.current = currentRoute;
  async function runAct(messageOverride?: string, externalImages?: any[]) {
    let finalMessage = messageOverride || prompt;
    const imagesToUse = externalImages || uploadedImages;

    if (!finalMessage.trim() && imagesToUse.length === 0) {
      alert('Please enter a task description or upload an image.');
      return;
    }

    // Add additional instructions in Chat Mode
    if (mode === 'chat') {
      finalMessage = finalMessage + "\n\nDo not modify code, only answer to the user's request.";
    }

    // Create request fingerprint for deduplication
    const requestFingerprint = JSON.stringify({
      message: finalMessage.trim(),
      imageCount: imagesToUse.length,
      cliPreference: preferredCli,
      model: selectedModel,
      mode
    });

    // Check for duplicate pending requests
    if (pendingRequestsRef.current.has(requestFingerprint)) {
      console.log('🔄 [DEBUG] Duplicate request detected, skipping:', requestFingerprint);
      return;
    }

    setIsRunning(true);
    const requestId = crypto.randomUUID();
    let tempUserMessageId: string | null = null;

    // Add to pending requests
    pendingRequestsRef.current.add(requestFingerprint);

    try {
      const uploadImageFromBase64 = async (img: { base64: string; name?: string }) => {
        const base64String = img.base64;
        const match = base64String.match(/^data:(.*?);base64,(.*)$/);
        const mimeType = match && match[1] ? match[1] : 'image/png';
        const base64Data = match && match[2] ? match[2] : base64String;

        const byteString = atob(base64Data);
        const buffer = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i += 1) {
          buffer[i] = byteString.charCodeAt(i);
        }

        const extension = (() => {
          if (mimeType.includes('png')) return 'png';
          if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
          if (mimeType.includes('gif')) return 'gif';
          if (mimeType.includes('webp')) return 'webp';
          if (mimeType.includes('svg')) return 'svg';
          return 'png';
        })();

        const inferredName = img.name && img.name.trim().length > 0 ? img.name.trim() : `image-${crypto.randomUUID()}.${extension}`;
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(inferredName);
        const filename = hasExtension ? inferredName : `${inferredName}.${extension}`;

        const file = new File([buffer], filename, { type: mimeType });
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE}/api/assets/${projectId}/upload`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Upload failed');
        }

        const result = await response.json();
        return {
          name: result.filename || filename,
          path: result.absolute_path,
          url: `/api/assets/${projectId}/${result.filename}`,
          public_url: typeof result.public_url === 'string' ? result.public_url : undefined,
          publicUrl: typeof result.public_url === 'string' ? result.public_url : undefined,
        };
      };

      console.log('🖼️ Processing images in runAct:', {
          imageCount: imagesToUse.length,
          cli: preferredCli,
          requestId
        });
      const processedImages: { name: string; path: string; url?: string; public_url?: string; publicUrl?: string }[] = [];

      for (let i = 0; i < imagesToUse.length; i += 1) {
        const image = imagesToUse[i];
        console.log(`🖼️ Processing image ${i}:`, {
          id: image.id,
          filename: image.filename,
          hasPath: !!image.path,
          hasPublicUrl: !!image.publicUrl,
          hasAssetUrl: !!image.assetUrl
        });
        if (image?.path) {
          const name = image.filename || image.name || `Image ${i + 1}`;
          const candidateUrl = typeof image.assetUrl === 'string' ? image.assetUrl : undefined;
          const candidatePublicUrl = typeof image.publicUrl === 'string' ? image.publicUrl : undefined;
          const processedImage = {
            name,
            path: image.path,
            url: candidateUrl && candidateUrl.startsWith('/') ? candidateUrl : undefined,
            public_url: candidatePublicUrl,
            publicUrl: candidatePublicUrl,
          };
          console.log(`🖼️ Created processed image ${i}:`, processedImage);
          processedImages.push(processedImage);
          continue;
        }

        if (image?.base64) {
          try {
            const uploaded = await uploadImageFromBase64({ base64: image.base64, name: image.name });
            processedImages.push(uploaded);
          } catch (uploadError) {
            console.error('Image upload failed:', uploadError);
            alert('Failed to upload image. Please try again.');
            setIsRunning(false);
            // Remove from pending requests
            pendingRequestsRef.current.delete(requestFingerprint);
            return;
          }
        }
      }

      const requestBody = {
        instruction: finalMessage,
        images: processedImages,
        isInitialPrompt: false,
        cliPreference: preferredCli,
        conversationId: conversationId || undefined,
        requestId,
        selectedModel,
        thinkingMode,
      };

      console.log('📸 Sending request to act API:', {
        messageLength: finalMessage.length,
        imageCount: processedImages.length,
        cli: preferredCli,
        requestId,
        images: processedImages.map(img => ({
          name: img.name,
          hasPath: !!img.path,
          hasUrl: !!img.url,
          hasPublicUrl: !!img.publicUrl
        }))
      });

      // Optimistically add user message to UI BEFORE API call for instant feedback
      tempUserMessageId = requestId + '-user-temp';
      if (messageHandlersRef.current) {
        const optimisticUserMessage = {
          id: tempUserMessageId,
          projectId: projectId,
          role: 'user' as const,
          messageType: 'chat' as const,
          content: finalMessage,
          conversationId: conversationId || null,
          requestId: requestId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isStreaming: false,
          isFinal: false,
          isOptimistic: true,
          metadata:
            processedImages.length > 0
              ? {
                  attachments: processedImages.map((img) => ({
                    name: img.name,
                    path: img.path,
                    url: img.url,
                    publicUrl: img.publicUrl ?? img.public_url,
                  })),
                }
              : undefined,
        };
        console.log('🔄 [Optimistic] Adding optimistic user message via stable handler:', {
          tempId: tempUserMessageId,
          requestId,
          content: finalMessage.substring(0, 50) + '...'
        });

        // Use stable handlers instead of direct messageHandlersRef to prevent reassignment issues
        if (stableMessageHandlers.current) {
          stableMessageHandlers.current.add(optimisticUserMessage);
        } else if (messageHandlersRef.current) {
          // Fallback to direct handlers if stable handlers aren't ready yet
          messageHandlersRef.current.add(optimisticUserMessage);
        }
      }

      // Add timeout to prevent indefinite waiting
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      let r: Response;
      try {
        r = await fetch(`${API_BASE}/api/chat/${projectId}/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!r.ok) {
          const errorText = await r.text();
          console.error('API Error:', errorText);

          if (tempUserMessageId) {
            console.log('🔄 [Optimistic] Removing optimistic user message due to API error via stable handler:', tempUserMessageId);
            if (stableMessageHandlers.current) {
              stableMessageHandlers.current.remove(tempUserMessageId);
            } else if (messageHandlersRef.current) {
              messageHandlersRef.current.remove(tempUserMessageId);
            }
          }

          alert(`Failed to send message: ${r.status} ${r.statusText}\n${errorText}`);
          return;
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          if (tempUserMessageId) {
            console.log('🔄 [Optimistic] Removing optimistic user message due to timeout via stable handler:', tempUserMessageId);
            if (stableMessageHandlers.current) {
              stableMessageHandlers.current.remove(tempUserMessageId);
            } else if (messageHandlersRef.current) {
              messageHandlersRef.current.remove(tempUserMessageId);
            }
          }

          alert('Request timed out after 60 seconds. Please check your connection and try again.');
          return;
        }
        throw fetchError;
      }

      const result = await r.json();

      console.log('📸 Act API response received:', {
        success: result.success,
        userMessageId: result.userMessageId,
        conversationId: result.conversationId,
        requestId: result.requestId,
        hasAttachments: processedImages.length > 0
      });

      const returnedConversationId =
        typeof result?.conversationId === 'string'
          ? result.conversationId
          : typeof result?.conversation_id === 'string'
          ? result.conversation_id
          : undefined;
      if (returnedConversationId) {
        setConversationId(returnedConversationId);
      }

      const resolvedRequestId =
        typeof result?.requestId === 'string'
          ? result.requestId
          : typeof result?.request_id === 'string'
          ? result.request_id
          : requestId;
      const userMessageId =
        typeof result?.userMessageId === 'string'
          ? result.userMessageId
          : typeof result?.user_message_id === 'string'
          ? result.user_message_id
          : '';

      createRequest(resolvedRequestId, userMessageId, finalMessage, mode);
      
      // Refresh data after completion
      await loadTree('.');

      // Reset prompt and uploaded images
      setPrompt('');
      // Clean up old format images if any
      if (uploadedImages && uploadedImages.length > 0) {
        uploadedImages.forEach(img => {
          if (img.url) URL.revokeObjectURL(img.url);
        });
        setUploadedImages([]);
      }
      
    } catch (error: any) {
      console.error('Act execution error:', error);

      if (tempUserMessageId) {
        console.log('🔄 [Optimistic] Removing optimistic user message due to execution error via stable handler:', tempUserMessageId);
        if (stableMessageHandlers.current) {
          stableMessageHandlers.current.remove(tempUserMessageId);
        } else if (messageHandlersRef.current) {
          messageHandlersRef.current.remove(tempUserMessageId);
        }
      }

      const errorMessage = error?.message || String(error);
      alert(`Failed to send message: ${errorMessage}\n\nPlease try again. If the problem persists, check the console for details.`);
    } finally {
      setIsRunning(false);
      // Remove from pending requests
      pendingRequestsRef.current.delete(requestFingerprint);
    }
  }


  // Handle project status updates via callback from ChatLog
  const handleProjectStatusUpdate = (status: string, message?: string) => {
    const previousStatus = projectStatus;
    
    // Ignore if status is the same (prevent duplicates)
    if (previousStatus === status) {
      return;
    }
    
    setProjectStatus(status as ProjectStatus);
    if (message) {
      setInitializationMessage(message);
    }
    
    // If project becomes active, stop showing loading UI
    if (status === 'active') {
      setIsInitializing(false);
      
      // Handle only when transitioning from initializing → active
      if (previousStatus === 'initializing') {

        // Start dependency installation
        startDependencyInstallation();
        loadTreeRef.current?.('.');
      }
      
      // Initial prompt: trigger once with shared guard (handles active-via-WS case)
      triggerInitialPromptIfNeeded();
    } else if (status === 'failed') {
      setIsInitializing(false);
    }
  };

  // Function to start dependency installation in background
  const handleRetryInitialization = async () => {
    setProjectStatus('initializing');
    setIsInitializing(true);
    setInitializationMessage('Retrying project initialization...');
    
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/retry-initialization`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        throw new Error('Failed to retry initialization');
      }
    } catch (error) {
      console.error('Failed to retry initialization:', error);
      setProjectStatus('failed');
      setInitializationMessage('Failed to retry initialization. Please try again.');
    }
  };

  // Load states from localStorage when projectId changes
  useEffect(() => {
    if (typeof window !== 'undefined' && projectId) {
      const storedHasInitialPrompt = localStorage.getItem(`project_${projectId}_hasInitialPrompt`);
      const storedTaskComplete = localStorage.getItem(`project_${projectId}_taskComplete`);
      
      if (storedHasInitialPrompt !== null) {
        setHasInitialPrompt(storedHasInitialPrompt === 'true');
      }
      if (storedTaskComplete !== null) {
        setAgentWorkComplete(storedTaskComplete === 'true');
      }
    }
  }, [projectId]);

  // NEW: Auto control preview server based on active request status
  const previousActiveState = useRef(false);
  
  useEffect(() => {
    if (!hasActiveRequests && !previewUrl && !isStartingPreview && !previewStartFailedRef.current) {
      if (!previousActiveState.current) {
        console.log('🔄 Preview not running; auto-starting');
      } else {
        console.log('✅ Task completed, ensuring preview server is running');
      }
      start();
    }

    // While the agent is running (it may be fixing whatever made the last start
    // fail), clear the failure latch so auto-start retries once the run finishes
    // (that idle transition re-runs this effect).
    if (hasActiveRequests) {
      previewStartFailedRef.current = false;
    }
    previousActiveState.current = hasActiveRequests;
  }, [hasActiveRequests, previewUrl, isStartingPreview, start]);

  // Poll for file changes in code view
  useEffect(() => {
    if (!showPreview && selectedFile && !hasUnsavedChanges) {
      const interval = setInterval(() => {
        reloadCurrentFile();
      }, 2000); // Check every 2 seconds

      return () => clearInterval(interval);
    }
  }, [showPreview, selectedFile, hasUnsavedChanges, reloadCurrentFile]);


  useEffect(() => {
    if (!projectId) {
      return;
    }

    let canceled = false;

    const initializeChat = async () => {
      try {
        const projectSettings = await loadProjectInfoRef.current?.();
        if (canceled) return;

        await loadSettingsRef.current?.(projectSettings);
        if (canceled) return;

        await loadTreeRef.current?.('.');
        if (canceled) return;

        await loadDeployStatusRef.current?.();
        if (canceled) return;

        checkCurrentDeploymentRef.current?.();
      } catch (error) {
        console.error('Failed to initialize chat view:', error);
      }
    };

    initializeChat();

    const handleServicesUpdate = () => {
      loadDeployStatusRef.current?.();
    };

    // NOTE: We intentionally do NOT stop the preview on `beforeunload` OR on
    // unmount/navigation. Killing the dev server forced a ~15-30s cold recompile
    // every time you returned to (or refreshed) a project. Leaving previews
    // running keeps multiple projects warm, so switching back is instant. The
    // PreviewManager bounds resource use on its own: it reaps idle previews
    // (PREVIEW_IDLE_TIMEOUT_MS) and LRU-evicts when the port pool is full.
    window.addEventListener('services-updated', handleServicesUpdate);

    return () => {
      canceled = true;
      window.removeEventListener('services-updated', handleServicesUpdate);

      // Stop deploy/publish pollers so they don't keep hitting the API after the
      // chat page unmounts (e.g. navigating back to the dashboard). The preview
      // itself is deliberately left running (see note above) so it stays warm.
      if (deployPollRef.current) { clearInterval(deployPollRef.current); deployPollRef.current = null; }
      if (giteaPollRef.current) { clearInterval(giteaPollRef.current); giteaPollRef.current = null; }
    };
  }, [projectId]);

  // Cleanup pending requests on unmount
  useEffect(() => {
    const pendingRequests = pendingRequestsRef.current;
    return () => {
      pendingRequests.clear();
    };
  }, []);

  // React to global settings changes when using global defaults
  const { settings: globalSettings } = useGlobalSettings();
  useEffect(() => {
    if (!usingGlobalDefaults) return;
    if (!globalSettings) return;

    const cli = sanitizeCli(globalSettings.default_cli);
    updatePreferredCli(cli);

    const modelFromGlobal = globalSettings.cli_settings?.[cli]?.model;
    if (modelFromGlobal) {
      updateSelectedModel(modelFromGlobal, cli);
    } else {
      updateSelectedModel(getDefaultModelForCli(cli), cli);
    }
  }, [globalSettings, usingGlobalDefaults, updatePreferredCli, updateSelectedModel]);


  // Show loading UI if project is initializing

  return (
    <>
      <style jsx global>{`
        /* Light theme syntax highlighting */
        .hljs {
          background: #f9fafb !important;
          color: #374151 !important;
        }
        
        .hljs-punctuation,
        .hljs-bracket,
        .hljs-operator {
          color: #1f2937 !important;
          font-weight: 600 !important;
        }
        
        .hljs-built_in,
        .hljs-keyword {
          color: #7c3aed !important;
          font-weight: 600 !important;
        }
        
        .hljs-string {
          color: #059669 !important;
        }
        
        .hljs-number {
          color: #dc2626 !important;
        }
        
        .hljs-comment {
          color: #6b7280 !important;
          font-style: italic;
        }
        
        .hljs-function,
        .hljs-title {
          color: #2563eb !important;
          font-weight: 600 !important;
        }
        
        .hljs-variable,
        .hljs-attr {
          color: #dc2626 !important;
        }
        
        .hljs-tag,
        .hljs-name {
          color: #059669 !important;
        }
        
        /* Make parentheses, brackets, and braces more visible */
        .hljs-punctuation:is([data-char="("], [data-char=")"], [data-char="["], [data-char="]"], [data-char="{"], [data-char="}"]) {
          color: #1f2937 !important;
          font-weight: bold !important;
          background: rgba(59, 130, 246, 0.1);
          border-radius: 2px;
          padding: 0 1px;
        }
        
      `}</style>

      {/* While resizing, this overlay sits above the preview iframe so it can't
          capture the mouse — keeps the drag smooth in both directions and lets
          mouseup register anywhere on screen. */}
      {isResizing && <div className="fixed inset-0 z-[100] cursor-col-resize select-none" />}

      <div className="h-screen bg-white dark:bg-gray-900 flex relative overflow-hidden">
        <div className="h-full w-full flex" ref={splitContainerRef}>
          {/* Left: Visual editor inspector (edit mode) or Chat window */}
          <div
            style={{ width: `${chatWidthPct}%` }}
            className="h-full flex flex-col min-w-0"
          >
            {editMode ? (
              <VisualEditorPanel
                element={selectedEl}
                edits={styleEdits}
                textEdit={textEdit}
                onApplyStyle={applyStyle}
                onApplyText={applyText}
                onPersist={persistEdits}
                onClose={() => setEditMode(false)}
                persisting={persistingEdit}
                busy={hasActiveRequests}
              />
            ) : showCommentsList ? (
              <CommentsListPanel
                comments={allComments}
                currentRoute={currentRoute}
                activeId={activePinId}
                onSelect={goToComment}
                onClose={() => setShowCommentsList(false)}
              />
            ) : (
            <>
            {/* Chat header */}
            <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 p-4 h-[73px] flex items-center">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => router.push('/')}
                  className="flex items-center justify-center w-8 h-8 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                  title="Back to home"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 12H5M12 19L5 12L12 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <div>
                  <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-50 ">{projectName || 'Loading...'}</h1>
                  {projectDescription && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 ">
                      {projectDescription}
                    </p>
                  )}
                </div>
              </div>
            </div>
            
            {/* Chat log area */}
            <div className="flex-1 min-h-0">
              <ChatErrorBoundary>
                <ChatLog
                  projectId={projectId}
                  serverBusy={hasActiveRequests}
                  onReverted={() => { setTimeout(() => refreshPreview(), 400); }}
                  onAddUserMessage={(handlers) => {
                    console.log('🔄 [HandlerSetup] ChatLog provided new handlers, updating references');
                    messageHandlersRef.current = handlers;

                    // Also update stable handlers if they exist
                    if (stableMessageHandlers.current) {
                      console.log('🔄 [HandlerSetup] Updating stable handlers reference');
                      // Note: stableMessageHandlers.current already has its own add/remove logic
                      // We don't replace it completely, just keep the reference to handlers
                    }
                  }}
                  onSessionStatusChange={(isRunningValue) => {
                  console.log('🔍 [DEBUG] Session status change:', isRunningValue);
                  setIsRunning(isRunningValue);
                  // Track agent task completion and auto-start preview
                  if (!isRunningValue && hasInitialPrompt && !agentWorkComplete && !previewUrl) {
                    setAgentWorkComplete(true);
                    // Save to localStorage
                    localStorage.setItem(`project_${projectId}_taskComplete`, 'true');
                    // Auto-start preview server after initial prompt task completion
                    start();
                  }
                }}
                onSseFallbackActive={(active) => {
                  console.log('🔄 [SSE] Fallback status:', active);
                  setIsSseFallbackActive(active);
                }}
                onProjectStatusUpdate={handleProjectStatusUpdate}
                startRequest={startRequest}
                completeRequest={completeRequest}
              />
              </ChatErrorBoundary>
            </div>
            
            {/* Simple input area */}
            <div className="p-4 rounded-bl-2xl">
              {queuedMessages.length > 0 && (
                <div className="mb-2 flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-300">
                  <span>{queuedMessages.length} message{queuedMessages.length > 1 ? 's' : ''} queued — will send after the current turn.</span>
                  <button onClick={() => setQueuedMessages([])} className="text-gray-400 hover:text-red-500">Clear</button>
                </div>
              )}
              <ChatInput
                onSendMessage={(message, images) => {
                  // CLI-style: you can always type. If a turn is in progress,
                  // QUEUE the message (it runs when the current turn finishes)
                  // instead of blocking. Use Stop to interrupt the current turn.
                  if (isRunning || hasActiveRequests) {
                    setQueuedMessages((q) => [...q, { message, images: images || [] }]);
                  } else {
                    runAct(message, images);
                  }
                }}
                // Never disabled — always allow typing/sending (queued while busy).
                disabled={false}
                placeholder={mode === 'act' ? "Ask Claudable..." : "Chat with Claudable..."}
                mode={mode}
                onModeChange={setMode}
                projectId={projectId}
                preferredCli={preferredCli}
                selectedModel={selectedModel}
                thinkingMode={thinkingMode}
                onThinkingModeChange={setThinkingMode}
                modelOptions={modelOptions}
                onModelChange={handleModelChange}
                modelChangeDisabled={isUpdatingModel}
                cliOptions={cliOptions}
                onCliChange={handleCliChange}
                cliChangeDisabled={isUpdatingModel}
              />
            </div>
            </>
            )}
          </div>

          {/* Draggable divider to resize the chat / preview split */}
          <div
            onMouseDown={startChatResize}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            className="group relative h-full w-px shrink-0 cursor-col-resize bg-gray-200 dark:bg-gray-800 hover:bg-[#DE7356] transition-colors"
          >
            {/* wider invisible hit area for easier grabbing */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            {/* visible grip so the divider is discoverable */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-3 rounded-full bg-gray-200 dark:bg-gray-800 group-hover:bg-[#DE7356] flex flex-col items-center justify-center gap-0.5 transition-colors">
              <span className="w-0.5 h-0.5 rounded-full bg-gray-400 group-hover:bg-white" />
              <span className="w-0.5 h-0.5 rounded-full bg-gray-400 group-hover:bg-white" />
              <span className="w-0.5 h-0.5 rounded-full bg-gray-400 group-hover:bg-white" />
            </div>
          </div>

          {/* Right: Preview/Code area */}
          <div className="h-full flex flex-col bg-black min-w-0" style={{ width: `${100 - chatWidthPct}%` }}>
            {/* Content area */}
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Controls Bar */}
              <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 h-[73px] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Toggle switch */}
                  <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                    <button
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        showPreview 
                          ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 ' 
                          : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 '
                      }`}
                      onClick={() => setShowPreview(true)}
                      title="Preview"
                      aria-label="Preview"
                      aria-pressed={showPreview}
                    >
                      <span className="w-4 h-4 flex items-center justify-center"><FaDesktop size={16} /></span>
                    </button>
                    <button
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        !showPreview 
                          ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50 ' 
                          : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 '
                      }`}
                      onClick={() => setShowPreview(false)}
                      title="Code"
                      aria-label="Code"
                      aria-pressed={!showPreview}
                    >
                      <span className="w-4 h-4 flex items-center justify-center"><FaCode size={16} /></span>
                    </button>
                  </div>

                  {/* Inline visual editor toggle — only meaningful with a live preview */}
                  {previewUrl && (
                    <button
                      onClick={() => { setShowPreview(true); setEditMode((v) => !v); }}
                      disabled={bridgeAbsent}
                      title={bridgeAbsent ? 'Visual editing needs the preview bridge (currently Nuxt only)' : editMode ? 'Exit visual editor' : 'Edit elements visually'}
                      className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        editMode
                          ? 'bg-[#DE7356] text-white border-[#DE7356]'
                          : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    </button>
                  )}

                  {/* Comment mode toggle */}
                  {previewUrl && (
                    <button
                      onClick={() => { setShowPreview(true); setCommentMode((v) => !v); }}
                      disabled={bridgeAbsent}
                      title={bridgeAbsent ? 'Comments need the preview bridge (currently Nuxt only)' : commentMode ? 'Exit comments' : 'Add comments to the page'}
                      className={`relative h-9 w-9 flex items-center justify-center rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        commentMode
                          ? 'bg-[#DE7356] text-white border-[#DE7356]'
                          : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>
                      {comments.length > 0 && (
                        <span className={`absolute -top-1.5 -right-1.5 min-w-[17px] h-[17px] px-1 rounded-full text-[10px] font-semibold flex items-center justify-center ring-2 ring-white ${commentMode ? 'bg-white dark:bg-gray-900 text-[#DE7356]' : 'bg-[#DE7356] text-white'}`}>{comments.length}</span>
                      )}
                    </button>
                  )}

                  {/* Show all comments in a left-pane list */}
                  {commentMode && previewUrl && (
                    <button
                      onClick={() => setShowCommentsList((v) => !v)}
                      title="List all comments across the site"
                      aria-label="List all comments"
                      aria-pressed={showCommentsList}
                      className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors ${
                        showCommentsList ? 'bg-[#DE7356] text-white border-[#DE7356]' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
                    </button>
                  )}

                  {/* Clear all comments (project-wide) */}
                  {commentMode && previewUrl && (
                    <button
                      onClick={clearAllComments}
                      title="Delete all comments in this project"
                      className="h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                    </button>
                  )}

                  {/* Center Controls */}
                  {showPreview && !editMode && !commentMode && previewUrl && (
                    <div className="flex items-center gap-3">
                      {/* Route Navigation */}
                      <div className="h-9 flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg px-3 border border-gray-200 dark:border-gray-700 ">
                        <span className="text-gray-400 dark:text-gray-500 mr-2">
                          <FaHome size={12} />
                        </span>
                        <span className="text-sm text-gray-500 dark:text-gray-400 mr-1">/</span>
                        <input
                          type="text"
                          value={currentRoute.startsWith('/') ? currentRoute.slice(1) : currentRoute}
                          onChange={(e) => {
                            const value = e.target.value;
                            setCurrentRoute(value ? `/${value}` : '/');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              navigateToRoute(currentRoute);
                            }
                          }}
                          className="bg-transparent text-sm text-gray-700 dark:text-gray-200 outline-none w-40"
                          placeholder="route"
                        />
                        <button
                          onClick={() => navigateToRoute(currentRoute)}
                          className="ml-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 "
                        >
                          <FaArrowRight size={12} />
                        </button>
                      </div>
                      
                      {/* Action Buttons Group */}
                      <div className="flex items-center gap-1.5">
                        <button 
                          className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                          onClick={() => {
                            const iframe = iframeRef.current;
                            if (iframe) {
                              iframe.src = iframe.src;
                            }
                          }}
                          title="Refresh preview"
                          aria-label="Refresh preview"
                        >
                          <FaRedo size={14} />
                        </button>

                        {/* Open preview in a new tab */}
                        <button
                          className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                          onClick={() => {
                            if (!previewUrl) return;
                            const suffix = currentRoute && currentRoute !== '/' ? currentRoute : '';
                            window.open(`${previewUrl}${suffix}`, '_blank', 'noopener');
                          }}
                          title="Open preview in new tab"
                          aria-label="Open preview in new tab"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </button>

                        {/* Device selector dropdown */}
                        <div className="relative">
                          <div className="h-9 flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                            <button
                              onClick={() => setDeviceMenuOpen((v) => !v)}
                              className="h-full flex items-center gap-1 px-2.5 text-sm text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-gray-100 rounded-l-lg"
                              title={`Device: ${currentDevice.name}`}
                            >
                              {currentDevice.desktop ? <FaDesktop size={14} /> : <FaMobileAlt size={14} />}
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                            </button>
                            {!currentDevice.desktop && (
                              <button
                                aria-label="Rotate orientation"
                                onClick={() => setOrientation((o) => (o === 'portrait' ? 'landscape' : 'portrait'))}
                                title={orientation === 'portrait' ? 'Rotate to landscape' : 'Rotate to portrait'}
                                className="h-7 w-7 mr-0.5 flex items-center justify-center rounded text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-white transition-colors border-l border-gray-200 dark:border-gray-700"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12a10 10 0 0 1 10-10c2.76 0 5.26 1.12 7.07 2.93M22 12a10 10 0 0 1-10 10c-2.76 0-5.26-1.12-7.07-2.93" /><polyline points="19 2 19 5 16 5" /><polyline points="5 22 5 19 8 19" /></svg>
                              </button>
                            )}
                          </div>
                          {deviceMenuOpen && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setDeviceMenuOpen(false)} />
                              <div className="absolute left-0 top-full mt-1 z-50 w-56 max-h-80 overflow-y-auto bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1">
                                {DEVICE_PRESETS.map((d) => (
                                  <button
                                    key={d.id}
                                    onClick={() => { setDeviceId(d.id); setDeviceMenuOpen(false); }}
                                    className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800 ${d.id === deviceId ? 'text-[#DE7356] font-medium' : 'text-gray-700 dark:text-gray-200'}`}
                                  >
                                    <span className="flex items-center gap-2 min-w-0">
                                      {d.desktop ? <FaDesktop size={12} className="shrink-0 text-gray-400 dark:text-gray-500" /> : <FaMobileAlt size={12} className="shrink-0 text-gray-400 dark:text-gray-500" />}
                                      <span className="truncate">{d.name}</span>
                                    </span>
                                    {!d.desktop && <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">{d.w}×{d.h}</span>}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="flex items-center gap-2">
                  <ThemeToggle />
                  {/* Architecture info */}
                  <button
                    onClick={() => setShowArchitecture(true)}
                    className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    title="Project architecture"
                    aria-label="Project architecture"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
                  </button>
                  {/* Settings Button */}
                  <button
                    onClick={() => setShowGlobalSettings(true)}
                    className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    title="Settings"
                    aria-label="Settings"
                  >
                    <FaCog size={16} />
                  </button>

                  {/* Skills */}
                  <button
                    onClick={() => setShowSkills(true)}
                    className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    title="Manage skills"
                    aria-label="Manage skills"
                  >
                    <FaPuzzlePiece size={15} />
                  </button>

                  {/* Import from Claude Design */}
                  <button
                    onClick={() => setShowDesignImport(true)}
                    className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    title="Import from Claude Design"
                    aria-label="Import from Claude Design"
                  >
                    <FaFileImport size={15} />
                  </button>

                  {/* Stop Button */}
                  {showPreview && previewUrl && (
                    <button
                      className="h-9 w-9 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors flex items-center justify-center"
                      onClick={stop}
                      title="Stop preview server"
                    >
                      <FaStop size={12} />
                    </button>
                  )}
                  
                  {/* Share a review link */}
                  {showPreview && previewUrl && (
                    <button
                      onClick={shareReviewLink}
                      title={shareCopied ? 'Review link copied to clipboard' : 'Get a public link for stakeholders to review + comment'}
                      className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors ${
                        shareCopied ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      {shareCopied ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
                      )}
                    </button>
                  )}

                  {/* Publish/Update */}
                  {showPreview && previewUrl && (
                    <div className="relative">
                    <button
                      className="relative h-9 w-9 flex items-center justify-center bg-black text-white rounded-lg transition-colors hover:bg-gray-900 dark:hover:bg-gray-200 border border-black/10 shadow-sm"
                      onClick={() => setShowPublishPanel(true)}
                      title="Publish this project"
                    >
                      <FaRocket size={14} />
                      {deploymentStatus === 'deploying' && (
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-white"></span>
                      )}
                      {deploymentStatus === 'ready' && (
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white"></span>
                      )}
                    </button>
                  </div>
                  )}

                  {/* My account — rightmost, so Publish stays to its left */}
                  <UserMenu />
                </div>
              </div>
              
              {/* Content Area */}
              <div className="flex-1 relative bg-black overflow-hidden">
                <AnimatePresence initial={false}>
                  {showPreview ? (
                  <MotionDiv
                    key="preview"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{ height: '100%' }}
                  >
                {previewUrl ? (
                  <div ref={deviceViewportRef} className="relative w-full h-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
                    <div
                      className={`relative bg-white dark:bg-gray-900 overflow-hidden shrink-0 ${
                        !deviceDims
                          ? 'w-full h-full'
                          : `border-gray-800 shadow-2xl ${(currentDevice.w ?? 0) < 500 ? 'rounded-[28px] border-8' : 'rounded-[18px] border-[12px]'}`
                      }`}
                      style={
                        !deviceDims
                          ? undefined
                          : { width: ddW, height: ddH, transform: deviceScale < 1 ? `scale(${deviceScale})` : undefined, transformOrigin: 'center' }
                      }
                    >
                      <iframe
                        ref={iframeRef}
                        className="w-full h-full border-none bg-white dark:bg-gray-900 "
                        src={previewUrl}
                        onError={() => {
                          // Show error overlay
                          const overlay = document.getElementById('iframe-error-overlay');
                          if (overlay) overlay.style.display = 'flex';
                        }}
                        onLoad={() => {
                          // Hide error overlay when loaded successfully
                          const overlay = document.getElementById('iframe-error-overlay');
                          if (overlay) overlay.style.display = 'none';
                          // Bridge-absence probe: if no plugin report lands within
                          // a grace window, this stack has no review bridge (non-Nuxt).
                          if (bridgeTimerRef.current) clearTimeout(bridgeTimerRef.current);
                          bridgeTimerRef.current = setTimeout(() => {
                            if (!previewReadyRef.current) setBridgeAbsent(true);
                          }, 5000);
                        }}
                      />

                      {/* Error overlay */}
                    <div 
                      id="iframe-error-overlay"
                      className="absolute inset-0 bg-gray-50 dark:bg-gray-900 flex items-center justify-center z-10"
                      style={{ display: 'none' }}
                    >
                      <div className="text-center max-w-md mx-auto p-6">
                        <div className="text-4xl mb-4">🔄</div>
                        <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">
                          Connection Issue
                        </h3>
                        <p className="text-gray-600 dark:text-gray-300 mb-4">
                          The preview couldn&apos;t load properly. Try clicking the refresh button to reload the page.
                        </p>
                        <button
                          className="flex items-center gap-2 mx-auto px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                          onClick={() => {
                            const iframe = iframeRef.current;
                            if (iframe) {
                              iframe.src = iframe.src;
                            }
                            const overlay = document.getElementById('iframe-error-overlay');
                            if (overlay) overlay.style.display = 'none';
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 4v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          Refresh Now
                        </button>
                      </div>
                    </div>
                    </div>

                    {/* Comment threads/compose — OUTSIDE the scaled frame so they
                        render full-size & unclipped; pins still render in the iframe. */}
                    {commentMode && (
                      <CommentsLayer
                        comments={comments}
                        positions={screenPinPositions}
                        activeId={activePinId}
                        compose={screenCompose}
                        viewport={deviceViewport}
                        onSubmitNew={submitNewComment}
                        onCancelCompose={() => setComposeAnchor(null)}
                        onResolve={resolveCommentById}
                        onDelete={deleteCommentById}
                        onCloseThread={() => setActivePinId(null)}
                      />
                    )}

                    {/* Runtime-error → one-click fix banner */}
                    {previewErrors.length > 0 && !hasActiveRequests && !editMode && !commentMode && (
                      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[92%]">
                        <div className="flex items-center gap-3 bg-red-600 text-white rounded-xl shadow-xl pl-3 pr-2 py-2">
                          <span className="shrink-0">⚠️</span>
                          <span className="text-sm truncate" title={previewErrors[previewErrors.length - 1]?.message}>
                            {previewErrors.length} runtime error{previewErrors.length > 1 ? 's' : ''} — {previewErrors[previewErrors.length - 1]?.message}
                          </span>
                          <button onClick={fixPreviewErrors} className="shrink-0 text-xs font-semibold bg-white dark:bg-gray-900 text-red-600 rounded-lg px-3 py-1.5 hover:bg-red-50">Fix with AI</button>
                          <button onClick={() => setPreviewErrors([])} className="shrink-0 text-white/80 hover:text-white text-sm px-1" aria-label="Dismiss">✕</button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full w-full flex items-center justify-center bg-gray-50 dark:bg-gray-900 relative">
                    {/* Gradient background similar to main page */}
                    <div className="absolute inset-0">
                      <div className="absolute inset-0 bg-white dark:bg-gray-900 " />
                      <div 
                        className="absolute inset-0 hidden transition-all duration-1000 ease-in-out"
                        style={{
                          background: `radial-gradient(circle at 50% 100%, 
                            ${activeBrandColor}66 0%, 
                            ${activeBrandColor}4D 25%, 
                            ${activeBrandColor}33 50%, 
                            transparent 70%)`
                        }}
                      />
                      {/* Light mode gradient - subtle */}
                      <div 
                        className="absolute inset-0 block transition-all duration-1000 ease-in-out"
                        style={{
                          background: `radial-gradient(circle at 50% 100%, 
                            ${activeBrandColor}40 0%, 
                            ${activeBrandColor}26 25%, 
                            transparent 50%)`
                        }}
                      />
                    </div>
                    
                    {/* Content with z-index to be above gradient */}
                    <div className="relative z-10 w-full h-full flex items-center justify-center">
                    {isStartingPreview ? (
                      <MotionDiv 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center"
                      >
                        {/* Claudable Symbol with loading spinner */}
                        <div className="w-40 h-40 mx-auto mb-6 relative">
                          <div 
                            className="w-full h-full"
                            style={{
                              backgroundColor: activeBrandColor,
                              mask: 'url(/Symbol_white.png) no-repeat center/contain',
                              WebkitMask: 'url(/Symbol_white.png) no-repeat center/contain',
                              opacity: 0.9
                            }}
                          />
                          
                          {/* Loading spinner in center */}
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div 
                              className="w-14 h-14 border-4 rounded-full animate-spin"
                              style={{
                                borderTopColor: 'transparent',
                                borderRightColor: activeBrandColor,
                                borderBottomColor: activeBrandColor,
                                borderLeftColor: activeBrandColor,
                              }}
                            />
                          </div>
                        </div>
                        
                        {/* Content */}
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-50 mb-3">
                          Starting Preview Server
                        </h3>
                        
                        <div className="flex items-center justify-center gap-1 text-gray-600 dark:text-gray-300 ">
                          <span>{previewInitializationMessage}</span>
                          <MotionDiv
                            className="flex gap-1 ml-2"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                          >
                            <MotionDiv
                              animate={{ opacity: [0, 1, 0] }}
                              transition={{ duration: 1.5, repeat: Infinity, delay: 0 }}
                              className="w-1 h-1 bg-gray-600 rounded-full"
                            />
                            <MotionDiv
                              animate={{ opacity: [0, 1, 0] }}
                              transition={{ duration: 1.5, repeat: Infinity, delay: 0.3 }}
                              className="w-1 h-1 bg-gray-600 rounded-full"
                            />
                            <MotionDiv
                              animate={{ opacity: [0, 1, 0] }}
                              transition={{ duration: 1.5, repeat: Infinity, delay: 0.6 }}
                              className="w-1 h-1 bg-gray-600 rounded-full"
                            />
                          </MotionDiv>
                        </div>
                      </MotionDiv>
                    ) : (
                    <div className="text-center">
                      <MotionDiv
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                      >
                        {/* Claudable Symbol */}
                        {hasActiveRequests ? (
                          <>
                            <div className="w-40 h-40 mx-auto mb-6 relative">
                              <MotionDiv
                                animate={{ rotate: 360 }}
                                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                                style={{ transformOrigin: "center center" }}
                                className="w-full h-full"
                              >
                          <div 
                            className="w-full h-full"
                            style={{
                              backgroundColor: activeBrandColor,
                              mask: 'url(/Symbol_white.png) no-repeat center/contain',
                              WebkitMask: 'url(/Symbol_white.png) no-repeat center/contain',
                              opacity: 0.9
                            }}
                          />
                              </MotionDiv>
                            </div>
                            
                            <h3 className="text-2xl font-bold mb-3 relative overflow-hidden inline-block">
                              <span 
                                className="relative"
                                style={{
                                  background: `linear-gradient(90deg, 
                                    #6b7280 0%, 
                                    #6b7280 30%, 
                                    #ffffff 50%, 
                                    #6b7280 70%, 
                                    #6b7280 100%)`,
                                  backgroundSize: '200% 100%',
                                  WebkitBackgroundClip: 'text',
                                  backgroundClip: 'text',
                                  WebkitTextFillColor: 'transparent',
                                  animation: 'shimmerText 5s linear infinite'
                                }}
                              >
                                Building...
                              </span>
                              <style>{`
                                @keyframes shimmerText {
                                  0% {
                                    background-position: 200% center;
                                  }
                                  100% {
                                    background-position: -200% center;
                                  }
                                }
                              `}</style>
                            </h3>
                          </>
                        ) : (
                          <>
                            <div
                              onClick={!isRunning && !isStartingPreview ? () => { previewStartFailedRef.current = false; start(); } : undefined}
                              className={`w-40 h-40 mx-auto mb-6 relative ${!isRunning && !isStartingPreview ? 'cursor-pointer group' : ''}`}
                            >
                              {/* Claudable Symbol with rotating animation when starting */}
                              <MotionDiv
                                className="w-full h-full"
                                animate={isStartingPreview ? { rotate: 360 } : {}}
                                transition={{ duration: 6, repeat: isStartingPreview ? Infinity : 0, ease: "linear" }}
                              >
                                <div 
                                  className="w-full h-full"
                                  style={{
                                    backgroundColor: activeBrandColor,
                                    mask: 'url(/Symbol_white.png) no-repeat center/contain',
                                    WebkitMask: 'url(/Symbol_white.png) no-repeat center/contain',
                                    opacity: 0.9
                                  }}
                                />
                              </MotionDiv>
                              
                              {/* Icon in Center - Play or Loading */}
                              <div className="absolute inset-0 flex items-center justify-center">
                                {isStartingPreview ? (
                                  <div 
                                    className="w-14 h-14 border-4 rounded-full animate-spin"
                                    style={{
                                      borderTopColor: 'transparent',
                                      borderRightColor: activeBrandColor,
                                      borderBottomColor: activeBrandColor,
                                      borderLeftColor: activeBrandColor,
                                    }}
                                  />
                                ) : (
                                  <MotionDiv
                                    className="flex items-center justify-center"
                                    whileHover={{ scale: 1.2 }}
                                    whileTap={{ scale: 0.9 }}
                                  >
                                    <FaPlay 
                                      size={32}
                                    />
                                  </MotionDiv>
                                )}
                              </div>
                            </div>
                            
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-3">
                              Preview Not Running
                            </h3>
                            
                            <p className="text-gray-600 dark:text-gray-300 max-w-lg mx-auto">
                              Start your development server to see live changes
                            </p>
                          </>
                        )}
                      </MotionDiv>
                    </div>
                    )}
                    </div>
                  </div>
                )}
                  </MotionDiv>
                ) : (
              <MotionDiv
                key="code"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex bg-white dark:bg-gray-900 "
              >
                {/* Left Sidebar - File Explorer (VS Code style) */}
                <div className="w-64 flex-shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col">
                  {/* File Tree */}
                  <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-900 custom-scrollbar">
                    {!tree || tree.length === 0 ? (
                      <div className="px-3 py-8 text-center text-[11px] text-gray-600 dark:text-gray-300 select-none">
                        No files found
                      </div>
                    ) : (
                      <TreeView 
                        entries={tree || []}
                        selectedFile={selectedFile}
                        expandedFolders={expandedFolders}
                        folderContents={folderContents}
                        onToggleFolder={toggleFolder}
                        onSelectFile={openFile}
                        onLoadFolder={handleLoadFolder}
                        level={0}
                        parentPath=""
                        getFileIcon={getFileIcon}
                      />
                    )}
                  </div>
                </div>

                {/* Right Editor Area */}
                <div className="flex-1 flex flex-col bg-white dark:bg-gray-900 min-w-0">
                  {selectedFile ? (
                    <>
                      {/* File Tab */}
                      <div className="flex-shrink-0 bg-gray-100 dark:bg-gray-800 ">
                        <div className="flex items-center gap-3 bg-white dark:bg-gray-900 px-3 py-1.5 border-t-2 border-t-blue-500 ">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-4 h-4 flex items-center justify-center">
                              {getFileIcon(tree.find(e => e.path === selectedFile) || { path: selectedFile, type: 'file' })}
                            </span>
                            <span className="truncate text-[13px] text-gray-700 dark:text-gray-200 " style={{ fontFamily: "'Segoe UI', Tahoma, sans-serif" }}>
                              {selectedFile.split('/').pop()}
                            </span>
                          </div>
                          {hasUnsavedChanges && (
                            <span className="text-[11px] text-amber-600 ">
                              • Unsaved changes
                            </span>
                          )}
                          {!hasUnsavedChanges && saveFeedback === 'success' && (
                            <span className="text-[11px] text-green-600 ">
                              Saved
                            </span>
                          )}
                          {saveFeedback === 'error' && (
                            <span
                              className="text-[11px] text-red-600 truncate max-w-[160px]"
                              title={saveError ?? 'Failed to save file'}
                            >
                              Save error
                            </span>
                          )}
                          {!hasUnsavedChanges && saveFeedback !== 'success' && isFileUpdating && (
                            <span className="text-[11px] text-green-600 ">
                              Updated
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              className="px-3 py-1 text-xs font-medium rounded bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-600 disabled:cursor-not-allowed "
                              onClick={handleSaveFile}
                              disabled={!hasUnsavedChanges || isSavingFile}
                              title="Save (Ctrl+S)"
                            >
                              {isSavingFile ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              className="text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 px-1 rounded"
                              onClick={() => {
                                if (hasUnsavedChanges) {
                                  const confirmClose =
                                    typeof window !== 'undefined'
                                      ? window.confirm('You have unsaved changes. Close without saving?')
                                      : true;
                                  if (!confirmClose) {
                                    return;
                                  }
                                }
                                setSelectedFile('');
                                setContent('');
                                setEditedContent('');
                                editedContentRef.current = '';
                                setHasUnsavedChanges(false);
                                setSaveFeedback('idle');
                                setSaveError(null);
                                setIsFileUpdating(false);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Code Editor */}
                      <div className="flex-1 overflow-hidden">
                        <div className="w-full h-full flex bg-white dark:bg-gray-900 overflow-hidden">
                          {/* Line Numbers */}
                          <div
                            ref={lineNumberRef}
                            className="bg-gray-50 dark:bg-gray-900 px-3 py-4 select-none flex-shrink-0 overflow-y-auto overflow-x-hidden custom-scrollbar pointer-events-none"
                            aria-hidden="true"
                          >
                            <div className="text-[13px] font-mono text-gray-500 dark:text-gray-400 leading-[19px]">
                              {(editedContent || '').split('\n').map((_, index) => (
                                <div key={index} className="text-right pr-2">
                                  {index + 1}
                                </div>
                              ))}
                            </div>
                          </div>
                          {/* Code Content */}
                          <div className="relative flex-1">
                            <pre
                              ref={highlightRef}
                              aria-hidden="true"
                              className="absolute inset-0 m-0 p-4 overflow-hidden text-[13px] leading-[19px] font-mono text-gray-800 dark:text-gray-100 whitespace-pre pointer-events-none"
                              style={{ fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace" }}
                            >
                              <code
                                className={`language-${getFileLanguage(selectedFile)}`}
                                dangerouslySetInnerHTML={{ __html: highlightedCode }}
                              />
                              <span className="block h-full min-h-[1px]" />
                            </pre>
                            <textarea
                              ref={editorRef}
                              value={editedContent}
                              onChange={onEditorChange}
                              onScroll={handleEditorScroll}
                              onKeyDown={handleEditorKeyDown}
                              spellCheck={false}
                              autoCorrect="off"
                              autoCapitalize="none"
                              autoComplete="off"
                              wrap="off"
                              aria-label="Code editor"
                              className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-gray-800 outline-none font-mono text-[13px] leading-[19px] p-4 whitespace-pre overflow-auto custom-scrollbar"
                              style={{ fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace" }}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    /* Welcome Screen */
                    <div className="flex-1 flex items-center justify-center bg-white dark:bg-gray-900 ">
                      <div className="text-center">
                        <span className="w-16 h-16 mb-4 opacity-10 text-gray-400 dark:text-gray-500 mx-auto flex items-center justify-center"><FaCode size={64} /></span>
                        <h3 className="text-lg font-medium text-gray-700 dark:text-gray-200 mb-2">
                          Welcome to Code Editor
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 ">
                          Select a file from the explorer to start viewing code
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </MotionDiv>
                )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>
      

      {/* Publish Modal */}
      <DesignImportModal
        projectId={projectId}
        isOpen={showDesignImport}
        onClose={() => setShowDesignImport(false)}
        onApply={(prompt) => { runAct(prompt); }}
      />

      <SkillsModal
        projectId={projectId}
        isOpen={showSkills}
        onClose={() => setShowSkills(false)}
      />

      {showPublishPanel && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowPublishPanel(false)} />
          <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-900/60 ">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white bg-black border border-black/10 ">
                  <FaRocket size={14} />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-50 ">Publish Project</h3>
                  <p className="text-xs text-gray-600 dark:text-gray-300 ">{isGitea ? 'Pushes your code to Git — auto-deploys via CI' : 'Deploy with Vercel, linked to your GitHub repo'}</p>
                </div>
              </div>
              <button onClick={() => setShowPublishPanel(false)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 ">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </div>

            <div className="p-6 space-y-4">
              {deploymentStatus === 'deploying' && (
                <div className="p-4 rounded-xl border border-blue-200 bg-blue-50 ">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm font-medium text-blue-700 ">
                      {deployRun?.state === 'queued' ? 'Queued — waiting for the runner…'
                        : deployRun?.state === 'running' ? 'Building & deploying…'
                        : 'Pushing to the repository…'}
                    </p>
                  </div>
                  <p className="text-xs text-blue-700/80 ">
                    {isGitea
                      ? 'Live status from CI — clone, build, route, health check.'
                      : 'Building and deploying your project. This may take a few minutes.'}
                  </p>
                  {isGitea && publishedUrl && (
                    <p className="text-xs text-blue-700/80 mt-1">Will be live at <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="font-mono underline">{publishedUrl}</a></p>
                  )}
                  {isGitea && deployRun?.url && (
                    <p className="text-xs text-blue-700/80 mt-1">
                      <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">
                        View build log{deployRun.runNumber ? ` (run #${deployRun.runNumber})` : ''} →
                      </a>
                    </p>
                  )}
                </div>
              )}

              {/* Neutral "currently live" state shown when the popup opens for an
                  already-deployed project (before the user clicks Update). */}
              {deploymentStatus !== 'deploying' && deploymentStatus !== 'ready' && deploymentStatus !== 'error' && isGitea && publishedUrl && (
                <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 ">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">Currently live at:</p>
                  <div className="flex items-center gap-2">
                    <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-gray-700 dark:text-gray-200 underline break-all flex-1">
                      {publishedUrl}
                    </a>
                    <button
                      onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                      className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 "
                    >
                      Copy
                    </button>
                  </div>
                  {deployRun?.state === 'success' && (deployRun?.title || deployRun?.updatedAt) && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      Last deployed{formatTimeAgo(deployRun.updatedAt) ? ` ${formatTimeAgo(deployRun.updatedAt)}` : ''}
                      {deployRun.title ? ` · ${deployRun.title}` : ''}
                      {deployRun.sha ? ` (${deployRun.sha})` : ''}
                      {deployRun.url ? <> · <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">log</a></> : null}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">Click Update to deploy your latest changes.</p>
                </div>
              )}

              {deploymentStatus === 'ready' && publishedUrl && (
                <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50 ">
                  <p className="text-sm font-medium text-emerald-700 mb-2">Published successfully</p>
                  <div className="flex items-center gap-2">
                    <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-mono text-emerald-700 underline break-all flex-1">
                      {publishedUrl}
                    </a>
                    <button
                      onClick={() => navigator.clipboard?.writeText(publishedUrl)}
                      className="px-2 py-1 text-xs rounded-lg border border-emerald-300/80 text-emerald-700 hover:bg-emerald-100 "
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}

              {deploymentStatus === 'error' && (
                <div className="p-4 rounded-xl border border-red-200 bg-red-50 ">
                  <p className="text-sm font-medium text-red-700 ">
                    {deployRun?.state === 'cancelled' ? 'Deployment was cancelled.' : 'Deployment failed.'}
                  </p>
                  {isGitea && deployRun?.url && (
                    <p className="text-xs text-red-600 mt-1">
                      <a href={deployRun.url} target="_blank" rel="noopener noreferrer" className="underline">
                        View the failed build log{deployRun.runNumber ? ` (run #${deployRun.runNumber})` : ''} →
                      </a>
                    </p>
                  )}
                </div>
              )}

              {!githubConnected || (!isGitea && !vercelConnected) ? (
                <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 ">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-50 mb-2">Connect the following services:</p>
                  <div className="space-y-1 text-amber-700 text-sm">
                    {!githubConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>Git repository not connected</div>)}
                    {!isGitea && !vercelConnected && (<div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-500"/>Vercel project not connected</div>)}
                  </div>
                  <button
                    className="mt-3 w-full px-4 py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 "
                    onClick={() => { setShowPublishPanel(false); setShowGlobalSettings(true); }}
                  >
                    Open Settings → Services
                  </button>
                </div>
              ) : null}

              <button
                disabled={publishLoading || deploymentStatus === 'deploying' || !githubConnected || (!isGitea && !vercelConnected)}
                onClick={async () => {
                  // Self-hosted Gitea flow: push to the Gitea repo; the Actions
                  // host-runner builds, deploys and routes the site. No Vercel.
                  if (isGitea) {
                    try {
                      setPublishLoading(true);
                      setDeploymentStatus('deploying');
                      setDeployRun({ state: 'queued' });
                      // Record the latest run number BEFORE pushing so polling
                      // only tracks the NEW run this publish creates.
                      let baselineRun: number | null = null;
                      try {
                        const s = await fetch(`${API_BASE}/api/projects/${projectId}/deploy/status`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
                        baselineRun = s?.found && typeof s.runNumber === 'number' ? s.runNumber : null;
                      } catch {}
                      const pushRes = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
                      if (!pushRes.ok) {
                        throw new Error(await pushRes.text());
                      }
                      const pushBody = await pushRes.json().catch(() => ({}));
                      const url = githubRepoName && gitDeployDomain
                        ? `https://${githubRepoName}.${gitDeployDomain}`
                        : publishedUrl;
                      if (url) setPublishedUrl(url);
                      setPublishLoading(false);
                      if (pushBody.pushed === false) {
                        // Nothing changed since the last deploy — it's already live.
                        setDeployRun(null);
                        setDeploymentStatus('ready');
                      } else {
                        // Track the real Gitea Actions run (queued -> running ->
                        // success/failure) instead of guessing with a timer.
                        startGiteaDeployPolling(baselineRun);
                      }
                    } catch (e) {
                      console.error('🚀 Gitea publish failed:', e);
                      alert('Publish failed. Make sure the project is connected to Gitea in Settings → Services.');
                      setDeploymentStatus('idle');
                      setPublishLoading(false);
                    }
                    return;
                  }
                  try {
                    setPublishLoading(true);
                    setDeploymentStatus('deploying');
                    // 1) Push to GitHub to ensure branch/commit exists
                    try {
                      const pushRes = await fetch(`${API_BASE}/api/projects/${projectId}/github/push`, { method: 'POST' });
                      if (!pushRes.ok) {
                        const err = await pushRes.text();
                        console.error('🚀 GitHub push failed:', err);
                        throw new Error(err);
                      }
                    } catch (e) {
                      console.error('🚀 GitHub push step failed', e);
                      throw e;
                    }
                    // Small grace period to let GitHub update default branch
                    await new Promise(r => setTimeout(r, 800));
                    // 2) Deploy to Vercel (branch auto-resolved on server)
                    const deployUrl = `${API_BASE}/api/projects/${projectId}/vercel/deploy`;
                    const vercelRes = await fetch(deployUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ branch: 'main' })
                    });
                    if (vercelRes.ok) {
                      const data = await vercelRes.json();
                      setDeploymentStatus('deploying');
                      if (data.deployment_id) startDeploymentPolling(data.deployment_id);
                      if (data.ready && data.deployment_url) {
                        const url = data.deployment_url.startsWith('http') ? data.deployment_url : `https://${data.deployment_url}`;
                        setPublishedUrl(url);
                        setDeploymentStatus('ready');
                      }
                    } else {
                      const errorText = await vercelRes.text();
                      console.error('🚀 Vercel deploy failed:', vercelRes.status, errorText);
                      setDeploymentStatus('idle');
                      setPublishLoading(false);
                    }
                  } catch (e) {
                    console.error('🚀 Publish failed:', e);
                    alert('Publish failed. Check Settings and tokens.');
                    setDeploymentStatus('idle');
                    setPublishLoading(false);
                    setTimeout(() => setShowPublishPanel(false), 1000);
                  } finally {
                    loadDeployStatus();
                  }
                }}
                className={`w-full px-4 py-3 rounded-xl font-medium text-white transition ${
                  publishLoading || deploymentStatus === 'deploying' || !githubConnected || (!isGitea && !vercelConnected)
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-black hover:bg-gray-900 dark:hover:bg-gray-200'
                }`}
              >
                {publishLoading ? 'Publishing…' : deploymentStatus === 'deploying' ? 'Deploying…' : (!githubConnected || (!isGitea && !vercelConnected)) ? 'Connect Services First' : (publishedUrl ? 'Update' : 'Publish')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Settings Modal */}
      <ProjectSettings
        isOpen={showGlobalSettings}
        onClose={() => setShowGlobalSettings(false)}
        projectId={projectId}
        projectName={projectName}
        projectDescription={projectDescription}
        initialTab="services"
        onProjectUpdated={({ name, description }) => {
          setProjectName(name);
          setProjectDescription(description ?? '');
        }}
      />
      <ArchitectureModal
        projectId={projectId}
        open={showArchitecture}
        onClose={() => setShowArchitecture(false)}
      />
    </>
  );
}
