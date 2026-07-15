"use client";
import { useEffect, useState, useRef, useCallback, useMemo, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MotionDiv, MotionH3, MotionP, MotionButton } from '@/lib/motion';
import { useRouter, useSearchParams, useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { FaCode, FaDesktop, FaMobileAlt, FaPlay, FaStop, FaCog, FaRocket, FaHome, FaArrowRight, FaRedo, FaFileImport, FaPuzzlePiece } from 'react-icons/fa';
import ChatLog from '@/components/chat/ChatLog';
import type { Entry } from '@/components/chat/CodeExplorer';
import UserMenu from '@/components/layout/UserMenu';
import type { SelectedElement } from '@/components/chat/VisualEditorPanel';
import CommentsLayer, { type CommentPin, type ComposeAnchor } from '@/components/chat/CommentsLayer';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/contexts/I18nContext';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import ThemeToggle from '@/components/ui/ThemeToggle';
import ChatInput from '@/components/chat/ChatInput';
import AgentStatusBar from '@/components/chat/AgentStatusBar';
import type { AgentUsageSnapshot } from '@/types/agent-usage';

// On-demand UI (code view, panels, modals) is code-split out of the initial
// chat bundle: these only download when first rendered. Everything here is
// conditionally mounted, so the chunks load on first open — not on page load.
const CodeExplorer = dynamic(() => import('@/components/chat/CodeExplorer'), { ssr: false });
const ProjectSettings = dynamic(
  () => import('@/components/settings/ProjectSettings').then((m) => m.ProjectSettings),
  { ssr: false },
);
const VisualEditorPanel = dynamic(() => import('@/components/chat/VisualEditorPanel'), { ssr: false });
const CommentsListPanel = dynamic(() => import('@/components/chat/CommentsListPanel'), { ssr: false });
const ArchitectureModal = dynamic(() => import('@/components/chat/ArchitectureModal'), { ssr: false });
const DesignImportModal = dynamic(() => import('@/components/chat/DesignImportModal'), { ssr: false });
const SkillsModal = dynamic(() => import('@/components/chat/SkillsModal'), { ssr: false });
const PublishPanel = dynamic(() => import('@/components/chat/PublishPanel'), { ssr: false });
const DesignExplorerBoard = dynamic(() => import('@/components/chat/DesignExplorerBoard'), { ssr: false });
import { getFileLanguage, escapeHtml } from '@/lib/utils/format';
import { ChatErrorBoundary } from '@/components/ErrorBoundary';
import { useUserRequests } from '@/hooks/useUserRequests';
import { useDeployPolling } from '@/hooks/useDeployPolling';
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

/** Locale-aware absolute date+time for the project-info panel; '' for bad/empty input. */
function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One label/value row in the project-info panel. */
function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-gray-400 dark:text-gray-500 shrink-0">{label}</dt>
      <dd className={`text-gray-800 dark:text-gray-200 text-right truncate ${mono ? 'font-mono text-[11px]' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

const sanitizeCli = (cli?: string | null) => sanitizeActiveCli(cli, DEFAULT_ACTIVE_CLI);

const sanitizeModel = (cli: string, model?: string | null) => normalizeModelForCli(cli, model, DEFAULT_ACTIVE_CLI);

// Function to convert hex to CSS filter for tinting white images
// Since the original image is white (#FFFFFF), we can apply filters more accurately
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
  // Inline edit of the project name + description in the chat header.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const savingNameRef = useRef(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const savingDescRef = useRef(false);
  const [projectDescription, setProjectDescription] = useState<string>('');
  // Project metadata for the topbar ⓘ info panel (who/when created + last edited).
  const [projectMeta, setProjectMeta] = useState<{
    createdBy: string | null;
    createdAt: string | null;
    lastEditedBy: string | null;
    lastActiveAt: string | null;
  }>({ createdBy: null, createdAt: null, lastEditedBy: null, lastActiveAt: null });
  const [showInfoPanel, setShowInfoPanel] = useState(false);
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
  // On interrupt, queued input is handed BACK to the composer. ChatInput owns its
  // own text/image state, so we push a draft to it imperatively (nonce-guarded) —
  // setting page-level `prompt` alone did nothing because the input never read it.
  const [draftRestore, setDraftRestore] = useState<{ text: string; images: any[]; nonce: number } | null>(null);
  const draftRestoreNonceRef = useRef(0);
  // Agent usage panel (context %, tokens, rate limits) — fed by SSE `agent_status`.
  const [agentStatus, setAgentStatus] = useState<AgentUsageSnapshot | null>(null);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const prevBusyRef = useRef(false);
  // Set when the user interrupts (Stop/Esc). CLI parity: an interrupt must NOT
  // fire the queued messages — instead they return to the input box. Consumed by
  // the queue-flush effect on the busy->idle edge the interrupt causes.
  const interruptedRef = useRef(false);
  const [isSseFallbackActive, setIsSseFallbackActive] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  // Design Explorer board (a third view alongside Preview/Code).
  const [designMode, setDesignMode] = useState(false);
  const toast = useToast();
  const t = useT();
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
  const [showClearCommentsConfirm, setShowClearCommentsConfirm] = useState(false);
  const [deviceId, setDeviceId] = useState<string>('desktop');
  const [orientation, setOrientation] = useState<'portrait'|'landscape'>('portrait');
  const [deviceScale, setDeviceScale] = useState(1);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [deviceViewport, setDeviceViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Close the topbar overflow ("⋯") menu on Escape.
  useEffect(() => {
    if (!overflowMenuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overflowMenuOpen]);
  // Close the project-info (ⓘ) panel on Escape.
  useEffect(() => {
    if (!showInfoPanel) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setShowInfoPanel(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showInfoPanel]);
  const deviceViewportRef = useRef<HTMLDivElement>(null);
  // Always points at the latest runAct closure (used by persistEdits).
  const runActRef = useRef<((m?: string, i?: any[]) => Promise<{ ok: boolean; busy: boolean } | void>) | null>(null);
  const currentRouteRef = useRef<string>('/');
  // User explicitly stopped the preview — suppress the auto-start effect until
  // they act again, else stop() (previewUrl→null) immediately re-triggered
  // auto-start and "Stop" just cold-restarted the server.
  const userStoppedPreviewRef = useRef(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  // Which tab the settings modal opens on: the gear opens General; the publish
  // panel's "Open Settings → Services" jumps straight to the Deploy tab.
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'services' | 'mcp' | 'plugins'>('general');
  // The MCP OAuth callback redirects back here with ?mcp_auth=success|error.
  // Surface the result and open the MCP tab so the user sees "authenticated".
  useEffect(() => {
    const result = searchParams?.get('mcp_auth');
    if (!result) return;
    if (result === 'success') {
      toast.success('MCP server authenticated.');
      setSettingsInitialTab('mcp');
      setShowGlobalSettings(true);
    } else {
      toast.error(`MCP authentication failed${searchParams?.get('mcp_auth_msg') ? `: ${searchParams.get('mcp_auth_msg')}` : ''}`);
    }
    // Strip the params so a reload doesn't re-fire the toast.
    const url = new URL(window.location.href);
    url.searchParams.delete('mcp_auth');
    url.searchParams.delete('mcp_auth_msg');
    window.history.replaceState({}, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
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
  // Deployment state + pollers (Vercel deployment poller, Gitea Actions run
  // poller) — extracted verbatim into useDeployPolling.
  const {
    publishedUrl,
    setPublishedUrl,
    setDeploymentId,
    deploymentStatus,
    setDeploymentStatus,
    deployRun,
    setDeployRun,
    giteaPollRef,
    startGiteaDeployPolling,
    startDeploymentPolling,
  } = useDeployPolling({ projectId, setPublishLoading, setShowPublishPanel });
  // Set when an auto-start fails, to stop the effect from re-firing start() every
  // ~2s (a tight retry loop that floods /preview/start). Cleared on success or
  // when the user explicitly clicks the Play button.
  const previewStartFailedRef = useRef(false);
  const [isStartingPreview, setIsStartingPreview] = useState(false);
  const [previewInitializationMessage, setPreviewInitializationMessage] = useState('Starting development server...');
  // Preview reachability (server-side probe): the cross-origin iframe can't
  // distinguish a healthy page from Traefik's 502 while the dev server
  // (re)starts. While unreachable we cover the iframe with a friendly overlay
  // and auto-reload it the moment the preview answers again.
  const [previewDown, setPreviewDown] = useState(false);
  const previewDownRef = useRef(false);
  // Cold start: whether the app has CONFIRMED a real render in the browser for
  // the current preview URL. On a brand-new app the iframe first loads a not-yet-
  // ready subdomain (Traefik 502 / DNS+cert still warming → Chrome's "site can't
  // be reached"), and nothing reloads it. `previewLoaded` latches true on the
  // first plugin report (previewReady) or bridge-absent grace (non-Nuxt loaded),
  // and gates a friendly "building" overlay + an auto-retry loop below.
  const [previewLoaded, setPreviewLoaded] = useState(false);
  // Delayed so a warm preview (opening an already-running project) doesn't flash
  // the overlay before it loads.
  const [showColdStart, setShowColdStart] = useState(false);
  // Live build/start log lines, streamed into the loading panel so the wait is
  // informative (installing deps → compiling → starting server) not opaque.
  const [previewLogs, setPreviewLogs] = useState<string[]>([]);
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

  // Capture a dashboard thumbnail on EVERY visit once the preview is up (the
  // server skips non-200 pages and keeps the old shot on failure, so this can't
  // save a "loading/error" frame). Delayed so the dev server has rendered.
  const thumbCapturedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!previewUrl || thumbCapturedForRef.current === projectId) return;
    const t = setTimeout(() => {
      thumbCapturedForRef.current = projectId;
      fetch(`${API_BASE}/api/projects/${projectId}/thumbnail`, { method: 'POST' }).catch(() => {});
    }, 7000);
    return () => clearTimeout(t);
  }, [previewUrl, projectId]);

  // Also capture when the user LEAVES the project (tab hide / navigate away),
  // so the dashboard tile shows the LAST state they saw, not the first.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      if (!previewUrlRef.current) return;
      // sendBeacon = fire-and-forget POST that survives page unload.
      try { navigator.sendBeacon(`${API_BASE}/api/projects/${projectId}/thumbnail`); } catch { /* best-effort */ }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [projectId]);

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

  // Queue handling on the busy -> idle edge, matching the Claude CLI:
  //  - turn finished NATURALLY -> auto-send the next queued message (one per turn);
  //  - turn was INTERRUPTED (Stop/Esc) -> do NOT fire the queue; return the queued
  //    text (and images) to the input so the user stays in control (like Esc in
  //    the CLI, which moves queued input back into the prompt rather than sending).
  useEffect(() => {
    const busy = isRunning || hasActiveRequests;
    if (prevBusyRef.current && !busy) {
      if (interruptedRef.current) {
        interruptedRef.current = false;
        if (queuedMessages.length > 0) {
          const text = queuedMessages.map((q) => q.message).join('\n\n');
          const imgs = queuedMessages.flatMap((q) => q.images || []);
          // Hand the queued text + images back to ChatInput's own composer state.
          draftRestoreNonceRef.current += 1;
          setDraftRestore({ text, images: imgs, nonce: draftRestoreNonceRef.current });
          setQueuedMessages([]);
        }
      } else if (queuedMessages.length > 0) {
        const next = queuedMessages[0];
        setQueuedMessages((q) => q.slice(1));
        void Promise.resolve(runActRef.current?.(next.message, next.images)).then((res) => {
          // If the send lost a race (another tab/turn grabbed the slot → 409) or
          // failed, put the message back at the FRONT so the next idle edge retries
          // it instead of silently dropping it.
          if (res && !res.ok && res.busy) {
            setQueuedMessages((q) => [next, ...q]);
          }
        });
      }
    }
    prevBusyRef.current = busy;
  }, [isRunning, hasActiveRequests, queuedMessages]);

  // Inline project rename (header). Commit on Enter/blur, Escape cancels; the
  // savingNameRef guards the Enter→blur double-fire (blur fires when the input
  // unmounts after Enter already saved — the classic lost-rename race).
  const commitProjectName = useCallback(async () => {
    if (savingNameRef.current) return;
    const next = nameDraft.trim();
    setEditingName(false);
    if (!next || next === projectName) return;
    savingNameRef.current = true;
    const previous = projectName;
    setProjectName(next); // optimistic
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(res.status === 403
          ? 'Only the project owner or an admin can rename this project.'
          : (json.message || 'Failed to rename project'));
      }
    } catch (e) {
      setProjectName(previous);
      toast.error(e instanceof Error ? e.message : 'Failed to rename project');
    } finally {
      savingNameRef.current = false;
    }
  }, [nameDraft, projectName, projectId, toast]);

  // Inline edit of the project description (may be cleared to empty, unlike name).
  const commitProjectDescription = useCallback(async () => {
    if (savingDescRef.current) return;
    const next = descDraft.trim();
    setEditingDesc(false);
    if (next === projectDescription) return;
    savingDescRef.current = true;
    const previous = projectDescription;
    setProjectDescription(next); // optimistic
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(res.status === 403
          ? 'Only the project owner or an admin can edit this project.'
          : (json.message || 'Failed to update description'));
      }
    } catch (e) {
      setProjectDescription(previous);
      toast.error(e instanceof Error ? e.message : 'Failed to update description');
    } finally {
      savingDescRef.current = false;
    }
  }, [descDraft, projectDescription, projectId, toast]);

  // /clear — drop the agent's conversation context (server clears the resume
  // pointer + usage counters and posts a confirmation message via SSE).
  const clearAgentContext = useCallback(async () => {
    if (isRunning || hasActiveRequests) {
      toast.error('The agent is still working — stop the current turn before clearing the context.');
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/chat/${projectId}/clear-session`, { method: 'POST' });
      if (!response.ok) {
        let message = 'Failed to clear the context.';
        try {
          const body = await response.json();
          if (body?.message) message = body.message;
        } catch { /* keep the default message */ }
        toast.error(message);
      }
    } catch {
      toast.error('Failed to clear the context.');
    }
  }, [isRunning, hasActiveRequests, projectId, toast]);

  // /help — local, ephemeral message listing the built-in commands.
  const showCommandHelp = useCallback(() => {
    const handlers = stableMessageHandlers.current ?? messageHandlersRef.current;
    handlers?.add({
      id: `local-help-${Date.now()}`,
      projectId,
      role: 'assistant',
      messageType: 'chat',
      content: [
        'Available commands:',
        '',
        '- `/clear` — start a fresh conversation context (chat history stays)',
        '- `/compact` — summarize the conversation to free up context space',
        '- `/usage` — show context usage, token spend and rate limits',
        '- `/help` — this list',
        '',
        'Type `/` to see these together with your project skills.',
      ].join('\n'),
      conversationId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isStreaming: false,
      isFinal: true,
      isOptimistic: true,
    });
  }, [projectId]);

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
        // Reset BOTH the state and the ref — triggerInitialPromptIfNeeded gates on
        // the ref, so leaving it set would strand the project's creation prompt
        // with no retry and no user feedback.
        setInitialPromptSent(false);
        initialPromptSentRef.current = false;
        toast.error('Could not start building — please try sending your prompt again.');
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
      initialPromptSentRef.current = false;
      toast.error('Could not start building — please try sending your prompt again.');
    } finally {
      setIsRunning(false);
    }
  }, [initialPromptSent, preferredCli, conversationId, projectId, selectedModel, thinkingMode, createRequest, toast]);

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
    async (option: ModelOption, opts?: { skipCliUpdate?: boolean; overrideCli?: string; silent?: boolean }) => {
      if (!projectId || !option) return;

      const { skipCliUpdate = false, overrideCli, silent = false } = opts || {};
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
        // Silent switches (auto-correcting a stale/renamed stored model on load)
        // must NOT post a "Switched to…" system message — otherwise every page
        // open spams the transcript. Only a user-initiated switch records it.
        if (!silent) {
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
        }

        loadCliStatuses();
      } catch (error) {
        console.error('Failed to update model preference:', error);
        updatePreferredCli(previousCli);
        updateSelectedModel(previousModel, previousCli);
        toast.error('Failed to update model. Please try again.');
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [projectId, preferredCli, selectedModel, conversationId, loadCliStatuses, persistProjectPreferences, updatePreferredCli, updateSelectedModel, toast]
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
        toast.error('Failed to update CLI. Please try again.');
      } finally {
        setIsUpdatingModel(false);
      }
    },
    [projectId, preferredCli, selectedModel, modelOptions, handleModelChange, loadCliStatuses, persistProjectPreferences, updatePreferredCli, updateSelectedModel, toast]
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
        // Auto-correction on load, not a user action: persist silently so we don't
        // post a "Switched to…" message into the chat on every page open.
        void handleModelChange(fallbackOption, { silent: true });
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
    // setPublishedUrl/setDeploymentStatus are stable useState setters (from useDeployPolling).
  }, [projectId, setPublishedUrl, setDeploymentStatus]);

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
  }, [isGitea, githubConnected, githubRepoName, gitDeployDomain, setPublishedUrl]);

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
    // giteaPollRef/setDeployRun/setPublishedUrl are stable (ref + useState setters from useDeployPolling).
  }, [showPublishPanel, isGitea, githubConnected, projectId, startGiteaDeployPolling, giteaPollRef, setDeployRun, setPublishedUrl]);

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
        }
      }
    } catch (e) {
      console.warn('Failed to check current deployment', e);
    }
    // setDeploymentId/setDeploymentStatus are stable useState setters (from useDeployPolling).
  }, [projectId, startDeploymentPolling, setDeploymentId, setDeploymentStatus]);

  const start = useCallback(async () => {
    // Any explicit start lifts the "user stopped it" latch.
    userStoppedPreviewRef.current = false;
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
      setPreviewLogs([]);

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
          // Stream the recent build/start lines into the loading panel.
          const recent = logs.slice(-14).map((l) => cleanLine(String(l || ''))).filter(Boolean);
          if (recent.length) setPreviewLogs(recent);
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

  // People picker for @-mentions in comments — the same org-scoped search that
  // powers project-access assignment (signed-in users only; empty on failure).
  const searchMentionUsers = useCallback(async (q: string) => {
    try {
      const r = await fetch(`${API_BASE}/api/users/search?q=${encodeURIComponent(q)}`);
      const j = await r.json().catch(() => null);
      if (!j?.success || !Array.isArray(j.data)) return [];
      return j.data
        .map((u: { id: string; name?: string | null; email?: string | null; image?: string | null }) => ({
          id: u.id,
          name: u.name || (u.email ? u.email.split('@')[0] : ''),
          email: u.email ?? undefined,
          image: u.image ?? null,
        }))
        .filter((u: { name: string }) => u.name);
    } catch {
      return [];
    }
  }, []);

  const submitNewComment = useCallback(async (body: string, mentions: { id: string; name: string }[]): Promise<boolean> => {
    if (!composeAnchor) return false;
    const route = currentRoute || '/';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`${API_BASE}/api/projects/${projectId}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ route, anchorSelector: composeAnchor.anchorSelector, relX: composeAnchor.relX, relY: composeAnchor.relY, body, mentions }),
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

  const clearAllComments = useCallback(() => {
    setShowClearCommentsConfirm(true);
  }, []);

  const confirmClearAllComments = useCallback(async () => {
    setShowClearCommentsConfirm(false);
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

  const refreshPreviewRef = useRef<() => void>(() => {});

  // Reachability poll: gentle cadence while healthy, faster while down; on the
  // down→up transition reload the iframe (it is showing Traefik's error page).
  useEffect(() => {
    if (!previewUrl || !showPreview) {
      previewDownRef.current = false;
      setPreviewDown(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Debounce: only overlay after TWO consecutive failed probes (fast recheck
    // in between). A dev server briefly re-scanning (e.g. during a large file
    // upload or HMR burst) must not flicker the overlay.
    let failStreak = 0;
    const probe = async () => {
      let reachable: boolean | null = null;
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/preview/health`, { cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (json?.success) reachable = !!json.data?.reachable;
      } catch {
        // Claudable itself unreachable (e.g. redeploy) — keep the current state.
      }
      if (cancelled) return;
      if (reachable === false) {
        failStreak += 1;
        if (failStreak >= 2 && !previewDownRef.current) {
          previewDownRef.current = true;
          setPreviewDown(true);
        }
      } else if (reachable === true) {
        failStreak = 0;
        if (previewDownRef.current) {
          previewDownRef.current = false;
          setPreviewDown(false);
          refreshPreviewRef.current();
        }
      }
      const delay = previewDownRef.current
        ? 2_500                       // down: poll for recovery
        : failStreak > 0
          ? 2_000                     // one failure seen: fast confirm
          : 6_000;                    // healthy cadence
      timer = setTimeout(probe, delay);
    };
    probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [previewUrl, showPreview, projectId]);

  // Cold-start latch: forget the "loaded" state whenever the preview URL changes
  // (new project / stop→start assigns a fresh URL), so the building overlay +
  // retry loop run for that URL until it truly renders. EXCEPTION: a warm page
  // REFRESH re-mounts with the SAME url that already rendered earlier this
  // session — replaying the "Building your app" cold-start overlay every refresh
  // is wrong. So start `loaded` from a per-URL sessionStorage flag; if the dev
  // server is actually down, the reachability poll flips previewDown and shows
  // the restarting overlay (and reloads on recovery) instead.
  useEffect(() => {
    if (!previewUrl) { setPreviewLoaded(false); return; }
    let seen = false;
    try { seen = sessionStorage.getItem(`previewLoaded:${previewUrl}`) === '1'; } catch { /* private mode */ }
    setPreviewLoaded(seen);
  }, [previewUrl]);

  // The app confirmed a real render once its plugin reports (previewReady) or,
  // for stacks without the bridge, once a loaded document sat without a report
  // (bridgeAbsent) AND the server probe says the dev server is up — so a
  // Traefik 502 page (dev server still down → previewDown) doesn't count as
  // loaded. Latch it so subsequent per-reload previewReady resets don't re-open
  // the overlay.
  useEffect(() => {
    if (previewReady || (bridgeAbsent && !previewDown)) {
      setPreviewLoaded(true);
      // Remember this URL rendered, so a later refresh skips the cold-start overlay.
      try { if (previewUrl) sessionStorage.setItem(`previewLoaded:${previewUrl}`, '1'); } catch { /* private mode */ }
    }
  }, [previewReady, bridgeAbsent, previewDown, previewUrl]);

  // Auto-retry the iframe while it hasn't confirmed a load. This is the missing
  // piece for NEW apps: the first load hits a not-ready subdomain/dev server and
  // sticks on the error page; reloading on a cadence picks the app up the moment
  // its subdomain (cert/DNS/route) and dev server are ready — then the plugin
  // reports and the loop stops. (The reachability poll handles later restarts.)
  // 6s > the 5s bridge-detect grace, so a successful load of a bridge-less stack
  // can settle (bridgeAbsent → previewLoaded) before the next reload.
  useEffect(() => {
    if (!previewUrl || !showPreview || previewLoaded) return;
    const t = setInterval(() => { refreshPreviewRef.current?.(); }, 6000);
    return () => clearInterval(t);
  }, [previewUrl, showPreview, previewLoaded]);

  // Show the "building" overlay only after a short grace, so a warm preview that
  // loads immediately doesn't flash it.
  useEffect(() => {
    if (!previewUrl || !showPreview || previewLoaded || editMode || commentMode) {
      setShowColdStart(false);
      return;
    }
    const t = setTimeout(() => setShowColdStart(true), 1200);
    return () => clearTimeout(t);
  }, [previewUrl, showPreview, previewLoaded, editMode, commentMode]);

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

  // Keep the reachability poll's reload handle current (the poll effect above
  // must not re-subscribe on every route keystroke).
  useEffect(() => { refreshPreviewRef.current = refreshPreview; }, [refreshPreview]);

  const stop = useCallback(async () => {
    try {
      userStoppedPreviewRef.current = true;
      await fetch(`${API_BASE}/api/projects/${projectId}/preview/stop`, { method: 'POST' });
      setPreviewUrl(null);
    } catch (error) {
      console.error('Error stopping preview:', error);
    }
  }, [projectId]);

  // Stable session-status callback: ChatLog keys its initial-load effect off
  // this prop (via checkActiveSession); an inline arrow gave it a new identity
  // every parent render → full history refetch per render.
  const sessionStatusDepsRef = useRef({ hasInitialPrompt, agentWorkComplete, previewUrl });
  useEffect(() => {
    sessionStatusDepsRef.current = { hasInitialPrompt, agentWorkComplete, previewUrl };
  }, [hasInitialPrompt, agentWorkComplete, previewUrl]);
  const handleSessionStatusChange = useCallback((isRunningValue: boolean) => {
    setIsRunning(isRunningValue);
    const d = sessionStatusDepsRef.current;
    // Track agent task completion and auto-start preview
    if (!isRunningValue && d.hasInitialPrompt && !d.agentWorkComplete && !d.previewUrl) {
      setAgentWorkComplete(true);
      localStorage.setItem(`project_${projectId}_taskComplete`, 'true');
      start();
    }
  }, [projectId, start]);

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
      // Theme CSS is the github-dark import in app/layout.tsx — no CDN fetch.
      import('highlight.js/lib/common').then(mod => {
        setHljs(mod.default);
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

      const hasCliSet = projectSettings?.cli || preferredCli;
      const hasModelSet = projectSettings?.model || selectedModel;

      if (!hasCliSet || !hasModelSet) {
        const globalResponse = await fetch(`${API_BASE}/api/settings/global`);
        if (globalResponse.ok) {
          const globalSettings = await globalResponse.json();
          const defaultCli = sanitizeCli(globalSettings.default_cli || globalSettings.defaultCli);
          const cliToUse = sanitizeCli(hasCliSet || defaultCli);

          if (!hasCliSet) {
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
      setProjectMeta({
        createdBy: project.createdBy ?? project.created_by ?? null,
        createdAt: project.createdAt ?? project.created_at ?? null,
        lastEditedBy: project.lastEditedBy ?? project.last_edited_by ?? null,
        lastActiveAt: project.lastActiveAt ?? project.last_active_at ?? project.updatedAt ?? project.updated_at ?? null,
      });

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

  // Apply ?cli=/&model= ONCE per page load. This effect re-fires when
  // preferredCli changes (it's a dep), so without the guard every later
  // dropdown change snapped straight back to the URL's values.
  const urlPrefsAppliedRef = useRef(false);
  useEffect(() => {
    if (!searchParams || urlPrefsAppliedRef.current) return;
    const cliParam = searchParams.get('cli');
    const modelParam = searchParams.get('model');
    if (!cliParam && !modelParam) {
      return;
    }
    urlPrefsAppliedRef.current = true;
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

      // Track optimistic messages by requestId
      if (message.isOptimistic && message.requestId) {
        optimisticMessagesRef.current.set(message.requestId, message);
      }

      // Also call the current handlers if they exist
      if (messageHandlersRef.current) {
        messageHandlersRef.current.add(message);
      }
    };

    const removeMessage = (messageId: string) => {

      // Remove from optimistic messages tracking if it's an optimistic message
      const optimisticMessage = Array.from(optimisticMessagesRef.current.values())
        .find(msg => msg.id === messageId);
      if (optimisticMessage && optimisticMessage.requestId) {
        optimisticMessagesRef.current.delete(optimisticMessage.requestId);
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

  runActRef.current = (m, i) => runAct(m, i);
  currentRouteRef.current = currentRoute;

  // CLI parity: Stop/Esc interrupts the running turn server-side. The SSE
  // 'completed' status it triggers flips isRunning; queued messages then flow.
  async function stopTurn() {
    // Mark this as a user interrupt so the busy->idle flush returns queued
    // messages to the input instead of auto-sending them (CLI parity). Only when
    // actually busy, so the flag can't linger and mis-handle a later turn.
    if (!(isRunning || hasActiveRequests)) return;
    interruptedRef.current = true;
    try {
      const r = await fetch(`${API_BASE}/api/chat/${projectId}/act/stop`, { method: 'POST' });
      // If the stop didn't land, the turn keeps streaming and will finish
      // NATURALLY — clear the interrupt flag so that natural completion auto-sends
      // the queue instead of being mistaken for an interrupt.
      if (!r.ok) interruptedRef.current = false;
    } catch {
      interruptedRef.current = false;
    }
  }

  async function runAct(messageOverride?: string, externalImages?: any[]) {
    let finalMessage = messageOverride || prompt;
    const imagesToUse = externalImages || uploadedImages;

    if (!finalMessage.trim() && imagesToUse.length === 0) {
      toast.info('Please enter a task description or upload an image.');
      return { ok: false, busy: false };
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
      return { ok: false, busy: false };
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

      const processedImages: { name: string; path: string; url?: string; public_url?: string; publicUrl?: string }[] = [];

      for (let i = 0; i < imagesToUse.length; i += 1) {
        const image = imagesToUse[i];
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
          processedImages.push(processedImage);
          continue;
        }

        if (image?.base64) {
          try {
            const uploaded = await uploadImageFromBase64({ base64: image.base64, name: image.name });
            processedImages.push(uploaded);
          } catch (uploadError) {
            console.error('Image upload failed:', uploadError);
            toast.error('Failed to upload image. Please try again.');
            setIsRunning(false);
            // Remove from pending requests
            pendingRequestsRef.current.delete(requestFingerprint);
            // Signal failure so the caller restores the message (don't lose it).
            return { ok: false, busy: false };
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
            if (stableMessageHandlers.current) {
              stableMessageHandlers.current.remove(tempUserMessageId);
            } else if (messageHandlersRef.current) {
              messageHandlersRef.current.remove(tempUserMessageId);
            }
          }

          // 409 = another turn is already running (e.g. a race with another tab,
          // or a queue flush that beat this one). Signal 'busy' so a queue-flush
          // caller can re-queue instead of dropping the message; stay quiet on the
          // toast for that case since it's transient and self-healing.
          if (r.status === 409) {
            return { ok: false, busy: true };
          }
          toast.error(`Failed to send message: ${r.status} ${r.statusText}`);
          return { ok: false, busy: false };
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          if (tempUserMessageId) {
            if (stableMessageHandlers.current) {
              stableMessageHandlers.current.remove(tempUserMessageId);
            } else if (messageHandlersRef.current) {
              messageHandlersRef.current.remove(tempUserMessageId);
            }
          }

          toast.error('Request timed out after 60 seconds. Please check your connection and try again.');
          return { ok: false, busy: false };
        }
        throw fetchError;
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

      return { ok: true, busy: false };
    } catch (error: any) {
      console.error('Act execution error:', error);

      if (tempUserMessageId) {
        if (stableMessageHandlers.current) {
          stableMessageHandlers.current.remove(tempUserMessageId);
        } else if (messageHandlersRef.current) {
          messageHandlersRef.current.remove(tempUserMessageId);
        }
      }

      const errorMessage = error?.message || String(error);
      toast.error(`Failed to send message: ${errorMessage}. Please try again — check the console if it persists.`);
      return { ok: false, busy: false };
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
    if (!hasActiveRequests && !previewUrl && !isStartingPreview && !previewStartFailedRef.current
        && !userStoppedPreviewRef.current) {
      if (!previousActiveState.current) {
      } else {
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

      // Deploy/publish pollers are stopped by useDeployPolling's own unmount
      // cleanup so they don't keep hitting the API after the chat page unmounts
      // (e.g. navigating back to the dashboard). The preview itself is
      // deliberately left running (see note above) so it stays warm.
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
      {isResizing && <div className="fixed inset-0 z-100 cursor-col-resize select-none" />}

      <div className="h-screen bg-white dark:bg-[#0c0a09] flex relative overflow-hidden">
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
            <div className="bg-white dark:bg-[#0c0a09] border-b border-gray-200 dark:border-white/8 p-4 h-[73px] flex items-center">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => router.push('/')}
                  className="flex items-center justify-center w-8 h-8 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/6 rounded-full transition-colors"
                  title="Back to home"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19 12H5M12 19L5 12L12 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <div className="min-w-0">
                  {editingName ? (
                    <input
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={() => void commitProjectName()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void commitProjectName(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingName(false); }
                      }}
                      autoFocus
                      maxLength={80}
                      className="text-lg font-semibold text-gray-900 dark:text-gray-50 bg-transparent border-b border-[#DE7356] focus:outline-hidden w-full max-w-md"
                      aria-label="Project name"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!projectName) return;
                        setNameDraft(projectName);
                        setEditingName(true);
                      }}
                      title="Rename project"
                      className="group flex items-center gap-1.5 text-left"
                    >
                      <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-50 truncate">{projectName || 'Loading...'}</h1>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  )}
                  {editingDesc ? (
                    <input
                      value={descDraft}
                      onChange={(e) => setDescDraft(e.target.value)}
                      onBlur={() => void commitProjectDescription()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void commitProjectDescription(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingDesc(false); }
                      }}
                      autoFocus
                      maxLength={160}
                      placeholder="Add a description…"
                      className="text-sm text-gray-500 dark:text-gray-400 bg-transparent border-b border-[#DE7356] focus:outline-hidden w-full max-w-md mt-0.5"
                      aria-label="Project description"
                    />
                  ) : projectName ? (
                    <button
                      type="button"
                      onClick={() => { setDescDraft(projectDescription); setEditingDesc(true); }}
                      title="Edit description"
                      className="group flex items-center gap-1.5 text-left"
                    >
                      <p className={`text-sm truncate ${projectDescription ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-600 italic'}`}>
                        {projectDescription || 'Add a description…'}
                      </p>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  ) : null}
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
                    messageHandlersRef.current = handlers;

                    // Also update stable handlers if they exist
                    if (stableMessageHandlers.current) {
                      // Note: stableMessageHandlers.current already has its own add/remove logic
                      // We don't replace it completely, just keep the reference to handlers
                    }
                  }}
                  onSessionStatusChange={handleSessionStatusChange}
                  onAgentStatus={setAgentStatus}
                onSseFallbackActive={(active) => {
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
                <div className="mb-2 flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/6 text-xs text-gray-600 dark:text-gray-300">
                  <span>{queuedMessages.length} message{queuedMessages.length > 1 ? 's' : ''} queued — will send after the current turn.</span>
                  <button onClick={() => setQueuedMessages([])} className="text-gray-400 hover:text-red-500">Clear</button>
                </div>
              )}
              <AgentStatusBar
                projectId={projectId}
                liveStatus={agentStatus}
                open={statusPanelOpen}
                onOpenChange={setStatusPanelOpen}
              />
              <ChatInput
                onSendMessage={(message, images) => {
                  // Built-in slash commands (CLI parity) run locally, never as a
                  // prompt. Only a BARE command (no extra words) is intercepted;
                  // "/clear the cart" is a real prompt. Attached images mean the
                  // user wants to send them, not run a command — skip interception.
                  const command = message.trim().toLowerCase();
                  const isBareCommand = !images || images.length === 0;
                  if (isBareCommand && (command === '/usage' || command === '/status')) {
                    setStatusPanelOpen(true);
                    return;
                  }
                  if (isBareCommand && command === '/help') {
                    showCommandHelp();
                    return;
                  }
                  if (isBareCommand && command === '/clear') {
                    void clearAgentContext();
                    return;
                  }
                  if (isBareCommand && command === '/mcp') {
                    // Like `/mcp` in the Claude CLI: open the project's MCP servers
                    // + their auth status, where you can authenticate.
                    setSettingsInitialTab('mcp');
                    setShowGlobalSettings(true);
                    return;
                  }
                  if (isBareCommand && command === '/plugin') {
                    // Like `/plugin` in the Claude CLI: open the plugins panel
                    // (marketplaces + which plugins are enabled).
                    setSettingsInitialTab('plugins');
                    setShowGlobalSettings(true);
                    return;
                  }
                  if (isBareCommand && command === '/compact') {
                    // The Claude CLI handles /compact natively. If a turn is in
                    // progress, QUEUE it (like any message) rather than dropping
                    // the user's typed command on the floor.
                    if (isRunning || hasActiveRequests) {
                      setQueuedMessages((q) => [...q, { message: '/compact', images: [] }]);
                    } else {
                      runAct('/compact', []);
                    }
                    return;
                  }
                  // CLI-style: you can always type. If a turn is in progress,
                  // QUEUE the message (it runs when the current turn finishes)
                  // instead of blocking. Use Stop to interrupt the current turn.
                  if (isRunning || hasActiveRequests) {
                    setQueuedMessages((q) => [...q, { message, images: images || [] }]);
                  } else {
                    // Fire the turn. ChatInput has already cleared the composer, so
                    // if the server was actually busy (409 — our idle state was
                    // stale, e.g. after an SSE drop during a preview restart) or the
                    // send failed, the message must NOT be lost: re-queue it (busy →
                    // flushes when the running turn ends) or hand it back to the
                    // composer so the user can retry.
                    void Promise.resolve(runAct(message, images)).then((res) => {
                      if (!res || res.ok) return;
                      if (res.busy) {
                        setQueuedMessages((q) => [...q, { message, images: images || [] }]);
                      } else {
                        draftRestoreNonceRef.current += 1;
                        setDraftRestore({ text: message, images: images || [], nonce: draftRestoreNonceRef.current });
                      }
                    });
                  }
                }}
                // Never disabled — always allow typing/sending (queued while busy).
                disabled={false}
                isRunning={isRunning || hasActiveRequests}
                onStop={stopTurn}
                restoreDraft={draftRestore}
                placeholder={t('chat.placeholder')}
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
            className="group relative z-30 h-full w-px shrink-0 cursor-col-resize bg-gray-200 dark:bg-white/6 hover:bg-[#DE7356] transition-colors"
          >
            {/* wider invisible hit area for easier grabbing */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            {/* visible grip so the divider is discoverable */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-3 rounded-full bg-gray-200 dark:bg-white/6 group-hover:bg-[#DE7356] flex flex-col items-center justify-center gap-0.5 transition-colors">
              <span className="w-0.5 h-0.5 rounded-full bg-gray-400 group-hover:bg-white" />
              <span className="w-0.5 h-0.5 rounded-full bg-gray-400 group-hover:bg-white" />
              <span className="w-0.5 h-0.5 rounded-full bg-gray-400 group-hover:bg-white" />
            </div>
          </div>

          {/* Right: Preview/Code area. `relative z-10` gives it its own stacking
              context so its iframe/black panes stay BELOW the resize grip (z-30),
              which overhangs into this column. */}
          <div className="relative z-10 h-full flex flex-col bg-black min-w-0" style={{ width: `${100 - chatWidthPct}%` }}>
            {/* Content area */}
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Controls Bar */}
              <div className="bg-white dark:bg-[#0c0a09] border-b border-gray-200 dark:border-white/8 px-4 h-[73px] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Toggle switch */}
                  <div className="flex items-center bg-gray-100 dark:bg-white/6 rounded-lg p-1">
                    <button
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        showPreview && !designMode
                          ? 'bg-white dark:bg-white/12 text-gray-900 dark:text-gray-50 '
                          : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 '
                      }`}
                      onClick={() => { setDesignMode(false); setShowPreview(true); }}
                      title="Preview"
                      aria-label="Preview"
                      aria-pressed={showPreview && !designMode}
                    >
                      <span className="w-4 h-4 flex items-center justify-center"><FaDesktop size={16} /></span>
                    </button>
                    <button
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        !showPreview && !designMode
                          ? 'bg-white dark:bg-white/12 text-gray-900 dark:text-gray-50 '
                          : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 '
                      }`}
                      onClick={() => { setDesignMode(false); setShowPreview(false); }}
                      title="Code"
                      aria-label="Code"
                      aria-pressed={!showPreview && !designMode}
                    >
                      <span className="w-4 h-4 flex items-center justify-center"><FaCode size={16} /></span>
                    </button>
                    <button
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        designMode
                          ? 'bg-white dark:bg-white/12 text-gray-900 dark:text-gray-50 '
                          : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 '
                      }`}
                      onClick={() => setDesignMode(true)}
                      title={t('designExplorer.title')}
                      aria-label={t('designExplorer.title')}
                      aria-pressed={designMode}
                    >
                      <span className="w-4 h-4 flex items-center justify-center">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                      </span>
                    </button>
                  </div>

                  {/* Center Controls */}
                  {showPreview && !editMode && !commentMode && previewUrl && (
                    <div className="flex items-center gap-3">
                      {/* Route Navigation */}
                      <div className="h-9 flex items-center bg-gray-100 dark:bg-white/6 rounded-lg px-3 border border-gray-200 dark:border-white/8 ">
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
                          className="bg-transparent text-sm text-gray-700 dark:text-gray-200 outline-hidden w-40"
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
                          className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-white/6 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/6 rounded-lg transition-colors"
                          // refreshPreview keeps the CURRENT route (`iframe.src = iframe.src`
                          // reloaded the last parent-set URL, losing in-app navigation).
                          onClick={refreshPreview}
                          title="Refresh preview"
                          aria-label="Refresh preview"
                        >
                          <FaRedo size={14} />
                        </button>

                        {/* Open preview in a new tab */}
                        <button
                          className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-white/6 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/6 rounded-lg transition-colors"
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
                          <div className="h-9 flex items-center bg-gray-100 dark:bg-white/6 rounded-lg border border-gray-200 dark:border-white/8">
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
                                className="h-7 w-7 mr-0.5 flex items-center justify-center rounded-sm text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-white transition-colors border-l border-gray-200 dark:border-white/8"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12a10 10 0 0 1 10-10c2.76 0 5.26 1.12 7.07 2.93M22 12a10 10 0 0 1-10 10c-2.76 0-5.26-1.12-7.07-2.93" /><polyline points="19 2 19 5 16 5" /><polyline points="5 22 5 19 8 19" /></svg>
                              </button>
                            )}
                          </div>
                          {deviceMenuOpen && (
                            <>
                              <div className="fixed inset-0 z-40" onClick={() => setDeviceMenuOpen(false)} />
                              <div className="absolute left-0 top-full mt-1 z-50 w-56 max-h-80 overflow-y-auto bg-white dark:bg-[#181310] rounded-lg shadow-xl border border-gray-200 dark:border-white/8 py-1">
                                {DEVICE_PRESETS.map((d) => (
                                  <button
                                    key={d.id}
                                    onClick={() => { setDeviceId(d.id); setDeviceMenuOpen(false); }}
                                    className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-50 dark:hover:bg-white/6 ${d.id === deviceId ? 'text-[#DE7356] font-medium' : 'text-gray-700 dark:text-gray-200'}`}
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
                  {/* Project info (ⓘ) — everything about this project at a glance. */}
                  <div className="relative">
                    <button
                      onClick={() => setShowInfoPanel((v) => !v)}
                      className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors ${
                        showInfoPanel
                          ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-white/15'
                          : 'bg-gray-100 dark:bg-white/6 text-gray-600 dark:text-gray-300 border-transparent hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/6'
                      }`}
                      title={t('project.info.title')}
                      aria-label={t('project.info.title')}
                      aria-haspopup="dialog"
                      aria-expanded={showInfoPanel}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </button>
                    {showInfoPanel && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowInfoPanel(false)} />
                        <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-[#181310] rounded-lg shadow-xl border border-gray-200 dark:border-white/8 p-4" role="dialog" aria-label={t('project.info.title')}>
                          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-50 mb-3">{t('project.info.title')}</h3>
                          <dl className="space-y-2 text-xs">
                            {projectDescription && (
                              <InfoRow label={t('project.info.description')} value={projectDescription} />
                            )}
                            <InfoRow label={t('project.info.createdBy')} value={projectMeta.createdBy || t('project.info.unknown')} />
                            <InfoRow label={t('project.info.createdAt')} value={fmtDateTime(projectMeta.createdAt) || t('project.info.unknown')} />
                            <InfoRow label={t('project.info.lastEditedBy')} value={projectMeta.lastEditedBy || t('project.info.unknown')} />
                            <InfoRow label={t('project.info.lastEditedAt')} value={fmtDateTime(projectMeta.lastActiveAt) || t('project.info.unknown')} />
                            <InfoRow label={t('project.info.assistant')} value={`${CLI_LABELS[preferredCli] || preferredCli}${selectedModel ? ` · ${getModelDisplayName(preferredCli, selectedModel)}` : ''}`} />
                            <InfoRow label={t('project.info.status')} value={projectStatus} />
                            <InfoRow label={t('project.info.id')} value={projectId} mono />
                          </dl>
                        </div>
                      </>
                    )}
                  </div>
                  {/* Settings — kept visible (common action) */}
                  <button
                    onClick={() => { setSettingsInitialTab('general'); setShowGlobalSettings(true); }}
                    className="h-9 w-9 flex items-center justify-center bg-gray-100 dark:bg-white/6 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/6 rounded-lg transition-colors"
                    title="Settings"
                    aria-label="Settings"
                  >
                    <FaCog size={16} />
                  </button>

                  {/* Overflow ("⋯") menu — secondary preview tools */}
                  <div className="relative">
                    <button
                      onClick={() => setOverflowMenuOpen((v) => !v)}
                      className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors ${
                        overflowMenuOpen
                          ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-white/15'
                          : 'bg-gray-100 dark:bg-white/6 text-gray-600 dark:text-gray-300 border-transparent hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/6'
                      }`}
                      title="More tools"
                      aria-label="More tools"
                      aria-haspopup="menu"
                      aria-expanded={overflowMenuOpen}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
                    </button>
                    {overflowMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setOverflowMenuOpen(false)} />
                        <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-60 max-h-[70vh] overflow-y-auto bg-white dark:bg-[#181310] rounded-lg shadow-xl border border-gray-200 dark:border-white/8 py-1">
                          {/* Edit elements (visual editor) */}
                          {previewUrl && (
                            <button
                              role="menuitem"
                              onClick={() => { setShowPreview(true); setEditMode((v) => !v); setOverflowMenuOpen(false); }}
                              disabled={bridgeAbsent}
                              title={bridgeAbsent ? 'Visual editing needs the preview bridge (currently Nuxt only)' : undefined}
                              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-white/6 ${editMode ? 'text-[#DE7356] font-medium' : 'text-gray-700 dark:text-gray-200'}`}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                              <span>Edit elements</span>
                            </button>
                          )}

                          {/* Comments */}
                          {previewUrl && (
                            <button
                              role="menuitem"
                              onClick={() => { setShowPreview(true); setCommentMode((v) => !v); setOverflowMenuOpen(false); }}
                              disabled={bridgeAbsent}
                              title={bridgeAbsent ? 'Comments need the preview bridge (currently Nuxt only)' : undefined}
                              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-white/6 ${commentMode ? 'text-[#DE7356] font-medium' : 'text-gray-700 dark:text-gray-200'}`}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>
                              <span>Comments{comments.length > 0 ? ` (${comments.length})` : ''}</span>
                            </button>
                          )}

                          {/* Show all comments in a list */}
                          {commentMode && previewUrl && (
                            <button
                              role="menuitem"
                              onClick={() => { setShowCommentsList((v) => !v); setOverflowMenuOpen(false); }}
                              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/6 ${showCommentsList ? 'text-[#DE7356] font-medium' : 'text-gray-700 dark:text-gray-200'}`}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
                              <span>Comments list</span>
                            </button>
                          )}

                          {/* Clear all comments */}
                          {commentMode && previewUrl && (
                            <button
                              role="menuitem"
                              onClick={() => { clearAllComments(); setOverflowMenuOpen(false); }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-gray-700 dark:text-gray-200 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                              <span>Clear comments</span>
                            </button>
                          )}

                          {/* Architecture */}
                          <button
                            role="menuitem"
                            onClick={() => { setShowArchitecture(true); setOverflowMenuOpen(false); }}
                            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 transition-colors"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
                            <span>Project architecture</span>
                          </button>

                          {/* Skills */}
                          <button
                            role="menuitem"
                            onClick={() => { setShowSkills(true); setOverflowMenuOpen(false); }}
                            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 transition-colors"
                          >
                            <span className="shrink-0 w-[15px] flex items-center justify-center"><FaPuzzlePiece size={14} /></span>
                            <span>Skills</span>
                          </button>

                          {/* Export the current preview page as PDF (headless Chromium print) */}
                          {previewUrl && (
                            <button
                              role="menuitem"
                              onClick={() => {
                                const route = currentRouteRef.current || '/';
                                window.open(`${API_BASE}/api/projects/${projectId}/export-pdf?path=${encodeURIComponent(route)}`, '_blank');
                                setOverflowMenuOpen(false);
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 transition-colors"
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><polyline points="9 15 12 18 15 15" /></svg>
                              <span>Export PDF</span>
                            </button>
                          )}

                          {/* Import from Claude Design */}
                          <button
                            role="menuitem"
                            onClick={() => { setShowDesignImport(true); setOverflowMenuOpen(false); }}
                            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6 transition-colors"
                          >
                            <span className="shrink-0 w-[15px] flex items-center justify-center"><FaFileImport size={14} /></span>
                            <span>Import design</span>
                          </button>

                          {/* Stop preview — destructive, bottom with divider */}
                          {showPreview && previewUrl && (
                            <>
                              <div className="my-1 border-t border-gray-200 dark:border-white/8" />
                              <button
                                role="menuitem"
                                onClick={() => { stop(); setOverflowMenuOpen(false); }}
                                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                              >
                                <span className="shrink-0 w-[15px] flex items-center justify-center"><FaStop size={12} /></span>
                                <span>Stop preview server</span>
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Share a review link */}
                  {showPreview && previewUrl && (
                    <button
                      onClick={shareReviewLink}
                      title={shareCopied ? 'Review link copied to clipboard' : 'Get a public link for stakeholders to review + comment'}
                      className={`h-9 w-9 flex items-center justify-center rounded-lg border transition-colors ${
                        shareCopied ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'border-gray-200 dark:border-white/8 bg-white dark:bg-white/3 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/6'
                      }`}
                    >
                      {shareCopied ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
                      )}
                    </button>
                  )}

                  {/* Publish/Update — primary CTA, labeled brand button */}
                  {showPreview && previewUrl && (() => {
                    const publishing = deploymentStatus === 'deploying' || publishLoading;
                    return (
                    <button
                      className="relative h-9 flex items-center gap-2 px-4 bg-[#DE7356] hover:bg-brand-600 text-white rounded-lg transition-colors shadow-xs font-medium text-sm"
                      onClick={() => setShowPublishPanel(true)}
                      title={publishing ? t('topbar.publishing') : t('topbar.publishTitle')}
                    >
                      {publishing ? (
                        <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                      ) : (
                        <FaRocket size={13} />
                      )}
                      <span>{publishing ? t('topbar.publishing') : t('topbar.publish')}</span>
                      {deploymentStatus === 'ready' && !publishing && (
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white"></span>
                      )}
                    </button>
                    );
                  })()}

                  {/* My account — rightmost, so Publish stays to its left */}
                  <UserMenu />
                </div>
              </div>
              
              {/* Content Area */}
              <div className="flex-1 relative bg-black overflow-hidden">
                {designMode ? (
                  <DesignExplorerBoard
                    projectId={projectId}
                    busy={isRunning || hasActiveRequests}
                    onApply={(prompt) => {
                      // Same busy rule as DesignImportModal: never launch a 2nd turn.
                      if (isRunning || hasActiveRequests) {
                        setQueuedMessages(prev => [...prev, { message: prompt, images: [] }]);
                      } else {
                        runAct(prompt);
                      }
                      setDesignMode(false);
                      setShowPreview(true);
                    }}
                  />
                ) : (
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
                  <div ref={deviceViewportRef} className="relative w-full h-full bg-gray-100 dark:bg-white/6 flex items-center justify-center overflow-hidden">
                    <div
                      className={`relative bg-white dark:bg-[#0c0a09] overflow-hidden shrink-0 ${
                        !deviceDims
                          ? 'w-full h-full'
                          : `border-gray-800 shadow-2xl ${(currentDevice.w ?? 0) < 500 ? 'rounded-[28px] border-8' : 'rounded-[18px] border-12'}`
                      }`}
                      style={
                        !deviceDims
                          ? undefined
                          : { width: ddW, height: ddH, transform: deviceScale < 1 ? `scale(${deviceScale})` : undefined, transformOrigin: 'center' }
                      }
                    >
                      <iframe
                        ref={iframeRef}
                        className="w-full h-full border-none bg-white dark:bg-[#0c0a09] "
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
                      className="absolute inset-0 bg-gray-50 dark:bg-[#0c0a09] flex items-center justify-center z-10"
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
                          className="flex items-center gap-2 mx-auto px-4 py-2 bg-[#DE7356] hover:bg-[#c9634a] text-white rounded-lg transition-colors"
                          onClick={() => {
                            refreshPreview();
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

                    {/* Cold-start overlay — a NEW app's subdomain/dev server isn't
                        ready on first load, so the iframe underneath is showing
                        Chrome's "site can't be reached". Cover it with a friendly
                        building state; the retry loop reloads until the app renders,
                        then previewLoaded latches and this clears automatically. */}
                    {showColdStart && !previewLoaded && (
                      <div className="absolute inset-0 z-20 bg-gray-50/95 dark:bg-[#0c0a09]/95 flex items-center justify-center">
                        <div className="text-center max-w-sm mx-auto p-6">
                          <div className="w-8 h-8 mx-auto mb-4 border-2 border-[#DE7356] border-t-transparent rounded-full animate-spin" />
                          <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-1">
                            Building your app
                          </h3>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            Setting up the preview — the first load of a new app can take a moment. This view opens automatically when it&apos;s ready.
                          </p>
                          {previewLogs.length > 0 && (
                            <p className="mt-3 text-xs font-mono text-gray-400 dark:text-gray-500 truncate" title={previewLogs[previewLogs.length - 1]}>
                              {previewLogs[previewLogs.length - 1]}
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Restarting overlay — covers Traefik's raw "Bad Gateway"
                        while an ALREADY-LOADED preview's dev server restarts;
                        cleared + auto-reloaded by the reachability poll. (The
                        first-ever load is handled by the cold-start overlay above.) */}
                    {previewDown && previewLoaded && (
                      <div className="absolute inset-0 z-20 bg-gray-50/95 dark:bg-[#0c0a09]/95 flex items-center justify-center">
                        <div className="text-center max-w-sm mx-auto p-6">
                          <div className="w-8 h-8 mx-auto mb-4 border-2 border-[#DE7356] border-t-transparent rounded-full animate-spin" />
                          <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-1">
                            Preview is restarting
                          </h3>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            The development server is coming back up — this view reconnects automatically.
                          </p>
                        </div>
                      </div>
                    )}
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
                        searchMentionUsers={searchMentionUsers}
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
                          <button onClick={fixPreviewErrors} className="shrink-0 text-xs font-semibold bg-white dark:bg-white/10 text-red-600 rounded-lg px-3 py-1.5 hover:bg-red-50">Fix with AI</button>
                          <button onClick={() => setPreviewErrors([])} className="shrink-0 text-white/80 hover:text-white text-sm px-1" aria-label="Dismiss">✕</button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full w-full flex items-center justify-center bg-gray-50 dark:bg-[#0c0a09] relative">
                    {/* Gradient background similar to main page */}
                    <div className="absolute inset-0">
                      <div className="absolute inset-0 bg-white dark:bg-[#0c0a09] " />
                      <div
                        className="absolute inset-0 hidden dark:block transition-all duration-1000 ease-in-out"
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
                        className="absolute inset-0 block dark:hidden transition-all duration-1000 ease-in-out"
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
                    {(isStartingPreview || isInitializing) ? (
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
                          {isStartingPreview ? 'Starting Preview Server' : 'Loading project…'}
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
                        {previewLogs.length > 0 && (
                          <div className="mt-6 mx-auto w-full max-w-lg text-left bg-gray-900/90 border border-gray-800 rounded-lg p-3 max-h-44 overflow-y-auto font-mono text-[11px] leading-relaxed text-gray-300 shadow-inner">
                            {previewLogs.map((l, i) => (
                              <div key={i} className="whitespace-pre-wrap break-all opacity-90">{l}</div>
                            ))}
                          </div>
                        )}
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
              <CodeExplorer
                key="code"
                tree={tree}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                folderContents={folderContents}
                onToggleFolder={toggleFolder}
                onSelectFile={openFile}
                onLoadFolder={handleLoadFolder}
                hasUnsavedChanges={hasUnsavedChanges}
                isSavingFile={isSavingFile}
                saveFeedback={saveFeedback}
                saveError={saveError}
                isFileUpdating={isFileUpdating}
                editedContent={editedContent}
                highlightedCode={highlightedCode}
                onSaveFile={handleSaveFile}
                onCloseFile={() => {
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
                onEditorChange={onEditorChange}
                onEditorScroll={handleEditorScroll}
                onEditorKeyDown={handleEditorKeyDown}
                editorRef={editorRef}
                highlightRef={highlightRef}
                lineNumberRef={lineNumberRef}
              />
                )}
                </AnimatePresence>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      

      {/* Publish Modal */}
      {showDesignImport && (
        <DesignImportModal
          projectId={projectId}
          isOpen={showDesignImport}
          onClose={() => setShowDesignImport(false)}
          onApply={(prompt) => {
            // Same busy rule as ChatInput: never launch a second concurrent turn.
            if (isRunning || hasActiveRequests) {
              setQueuedMessages(prev => [...prev, { message: prompt, images: [] }]);
            } else {
              runAct(prompt);
            }
          }}
        />
      )}

      {showSkills && (
        <SkillsModal
          projectId={projectId}
          isOpen={showSkills}
          onClose={() => setShowSkills(false)}
        />
      )}

      {showPublishPanel && (
        <PublishPanel
          projectId={projectId}
          isGitea={isGitea}
          deploymentStatus={deploymentStatus}
          setDeploymentStatus={setDeploymentStatus}
          deployRun={deployRun}
          setDeployRun={setDeployRun}
          publishedUrl={publishedUrl}
          setPublishedUrl={setPublishedUrl}
          githubConnected={githubConnected}
          vercelConnected={vercelConnected}
          githubRepoName={githubRepoName}
          gitDeployDomain={gitDeployDomain}
          publishLoading={publishLoading}
          setPublishLoading={setPublishLoading}
          startGiteaDeployPolling={startGiteaDeployPolling}
          startDeploymentPolling={startDeploymentPolling}
          loadDeployStatus={loadDeployStatus}
          onClose={() => setShowPublishPanel(false)}
          onOpenServiceSettings={() => { setShowPublishPanel(false); setSettingsInitialTab('services'); setShowGlobalSettings(true); }}
        />
      )}

      {/* Project Settings Modal */}
      {showGlobalSettings && (
        <ProjectSettings
          isOpen={showGlobalSettings}
          onClose={() => setShowGlobalSettings(false)}
          projectId={projectId}
          projectName={projectName}
          projectDescription={projectDescription}
          initialTab={settingsInitialTab}
          onProjectUpdated={({ name, description }) => {
            setProjectName(name);
            setProjectDescription(description ?? '');
          }}
        />
      )}
      {showArchitecture && (
        <ArchitectureModal
          projectId={projectId}
          open={showArchitecture}
          onClose={() => setShowArchitecture(false)}
        />
      )}
      <ConfirmDialog
        open={showClearCommentsConfirm}
        title="Delete all comments?"
        message="This removes every comment in this project, across all routes. This cannot be undone."
        confirmLabel="Delete all"
        destructive
        onConfirm={confirmClearAllComments}
        onCancel={() => setShowClearCommentsConfirm(false)}
      />
    </>
  );
}
