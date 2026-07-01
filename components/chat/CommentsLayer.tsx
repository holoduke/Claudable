"use client";
import { useEffect, useRef, useState } from 'react';

export interface CommentPin {
  id: string;
  index: number;
  route: string;
  anchorSelector: string;
  relX: number;
  relY: number;
  body: string;
  resolved: boolean;
  authorName: string;
  authorImage: string | null;
  createdAt: string;
}

export interface ComposeAnchor {
  anchorSelector: string;
  relX: number;
  relY: number;
  x: number;
  y: number;
}

interface CommentsLayerProps {
  comments: CommentPin[];
  positions: Record<string, { x: number | null; y: number | null }>;
  activeId: string | null;
  compose: ComposeAnchor | null;
  viewport: { w: number; h: number };
  /** Return true on success, false on failure — drives the inline error state. */
  onSubmitNew: (body: string) => Promise<boolean> | boolean | void;
  onCancelCompose: () => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onCloseThread: () => void;
  /** Hide Resolve/Delete (e.g. guests on the share page can't manage). */
  readOnly?: boolean;
}

/** Keep a popover of size (w,h) fully inside the viewport, anchored near (x,y). */
function clampPopover(x: number, y: number, w: number, h: number, vw: number, vh: number) {
  const left = Math.max(8, Math.min(x - 12, (vw || w) - w - 8));
  const top = Math.max(8, Math.min(y + 8, (vh || h) - h - 8));
  return { left, top };
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  return image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className="w-6 h-6 rounded-full object-cover" />
  ) : (
    <span className="w-6 h-6 rounded-full bg-[#DE7356]/15 text-[#DE7356] text-xs font-semibold flex items-center justify-center">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Absolute overlay sized to the iframe; pin coords are iframe-viewport coords. */
export default function CommentsLayer({
  comments, positions, activeId, compose, viewport, onSubmitNew, onCancelCompose, onResolve, onDelete, onCloseThread, readOnly = false,
}: CommentsLayerProps) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  // Reset ONLY when a genuinely new comment is placed — key on the placement
  // identity (anchor + rel position), NOT the `compose` object, whose identity
  // churns as the pane resizes (live-positioned). Keying on the object wiped the
  // user's draft (and re-enabled submit mid-flight) on any resize. See review.
  const composeKey = compose ? `${compose.anchorSelector}|${compose.relX}|${compose.relY}` : '';
  useEffect(() => {
    if (!composeKey) return;
    setDraft('');
    setSubmitError(null);
    setSubmitting(false);
    const t = setTimeout(() => composeRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [composeKey]);

  // One submit at a time. Awaits the parent's POST, surfaces failures inline, and
  // guards against a second click adding the comment twice.
  const doSubmit = async () => {
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const ok = await onSubmitNew(text);
      if (ok === false) setSubmitError('Couldn’t add your comment — check your connection and try again.');
    } catch {
      setSubmitError('Couldn’t add your comment — check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const active = activeId ? comments.find((c) => c.id === activeId) : null;
  const activePos = activeId ? positions[activeId] : null;

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      {/* New-comment compose card */}
      {compose && (
        <div
          className="absolute pointer-events-auto w-64 bg-white rounded-lg shadow-xl border border-gray-200 p-2"
          style={clampPopover(compose.x, compose.y, 256, 130, viewport.w, viewport.h)}
        >
          <textarea
            ref={composeRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doSubmit(); } if (e.key === 'Escape') onCancelCompose(); }}
            placeholder="Add a comment…"
            rows={3}
            disabled={submitting}
            className="w-full text-sm border border-gray-200 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-[#DE7356]/30 resize-none disabled:opacity-60"
          />
          {submitError && <p className="text-[11px] text-red-600 mt-1 px-0.5">{submitError}</p>}
          <div className="flex items-center justify-end gap-2 mt-1">
            <button onClick={onCancelCompose} disabled={submitting} className="text-xs text-gray-500 hover:text-gray-800 px-2 py-1 disabled:opacity-40">Cancel</button>
            <button
              onClick={() => void doSubmit()}
              disabled={!draft.trim() || submitting}
              className="text-xs font-medium text-white bg-[#DE7356] hover:bg-[#c65f43] rounded-md px-3 py-1 disabled:opacity-40 flex items-center gap-1.5"
            >
              {submitting && (
                <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
              )}
              {submitting ? 'Adding…' : 'Comment'}
            </button>
          </div>
        </div>
      )}

      {/* Open thread for the active pin */}
      {active && activePos && activePos.x !== null && activePos.y !== null && (
        <div
          className="absolute pointer-events-auto w-72 bg-white rounded-lg shadow-xl border border-gray-200"
          style={clampPopover(activePos.x, activePos.y, 288, 150, viewport.w, viewport.h)}
        >
          <div className="flex items-start gap-2 p-3">
            <Avatar name={active.authorName} image={active.authorImage} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 truncate">{active.authorName}</span>
                <span className="text-[11px] text-gray-400">{timeAgo(active.createdAt)}</span>
              </div>
              <p className={`text-sm text-gray-700 mt-1 whitespace-pre-wrap break-words ${active.resolved ? 'line-through text-gray-400' : ''}`}>{active.body}</p>
            </div>
            <button onClick={onCloseThread} className="text-gray-300 hover:text-gray-600 text-sm shrink-0" aria-label="Close">✕</button>
          </div>
          {!readOnly && (
            <div className="flex items-center justify-end gap-2 px-3 pb-2 border-t border-gray-100 pt-2">
              <button onClick={() => onResolve(active.id, !active.resolved)} className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100">
                {active.resolved ? 'Reopen' : 'Resolve'}
              </button>
              <button onClick={() => onDelete(active.id)} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50">Delete</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
