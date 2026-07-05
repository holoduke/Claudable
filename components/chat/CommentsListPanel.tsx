"use client";
import { useMemo, useState } from 'react';
import type { CommentPin } from './CommentsLayer';

interface Props {
  comments: (CommentPin & { route: string })[];
  currentRoute: string;
  activeId: string | null;
  onSelect: (c: CommentPin & { route: string }) => void;
  onClose: () => void;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Left-pane overview of every comment across the site, grouped by route.
 *  Clicking one asks the parent to jump the preview there and scroll to it. */
export default function CommentsListPanel({ comments, currentRoute, activeId, onSelect, onClose }: Props) {
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const groups = useMemo(() => {
    const byRoute = new Map<string, (CommentPin & { route: string })[]>();
    const filtered = comments.filter((c) => filter === 'all' || (filter === 'open' ? !c.resolved : c.resolved));
    for (const c of filtered) {
      const r = c.route || '/';
      const arr = byRoute.get(r) ?? [];
      arr.push(c);
      byRoute.set(r, arr);
    }
    // Number pins per route (matches the on-page pin index) and sort routes.
    return [...byRoute.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([route, list]) => ({
        route,
        items: list
          .slice()
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .map((c, i) => ({ ...c, index: i + 1 })),
      }));
  }, [comments, filter]);

  const open = comments.filter((c) => !c.resolved).length;
  const resolved = comments.length - open;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#0c0a09]">
      <div className="border-b border-gray-200 dark:border-white/[0.08] p-4 h-[73px] flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50">Comments</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">{comments.length} total · {open} open</p>
        </div>
        <button onClick={onClose} title="Close list" className="w-8 h-8 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.06] rounded-full">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      {comments.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-gray-100 dark:border-white/[0.08] shrink-0">
          {([['all', `All ${comments.length}`], ['open', `Open ${open}`], ['resolved', `Resolved ${resolved}`]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                filter === key ? 'bg-[#DE7356] text-white border-[#DE7356]' : 'bg-white dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.06]'
              }`}
            >{label}</button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 text-gray-400 dark:text-gray-500">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mb-2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>
            {comments.length === 0 ? (
              <>
                <p className="text-sm">No comments yet.</p>
                <p className="text-xs mt-1">Click anywhere on the preview to add one.</p>
              </>
            ) : (
              <p className="text-sm">No {filter} comments.</p>
            )}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.route}>
              <div className="sticky top-0 z-10 bg-gray-50 dark:bg-white/[0.03] backdrop-blur px-4 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-white/[0.08] flex items-center gap-2">
                <span className="truncate">{g.route}</span>
                {g.route === (currentRoute || '/') && <span className="text-[9px] uppercase tracking-wide text-[#DE7356] bg-[#DE7356]/10 px-1.5 py-0.5 rounded">current</span>}
                <span className="ml-auto text-gray-400 dark:text-gray-500">{g.items.length}</span>
              </div>
              {g.items.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelect(c)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.06] transition-colors flex gap-3 ${activeId === c.id ? 'bg-[#DE7356]/5' : ''}`}
                >
                  <span className={`shrink-0 w-6 h-6 rounded-full text-[11px] font-semibold flex items-center justify-center ${c.resolved ? 'bg-gray-100 dark:bg-white/[0.06] text-gray-400 dark:text-gray-500' : 'bg-[#DE7356] text-white'}`}>{c.index}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">{c.authorName || 'Anonymous'}</span>
                      <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">{timeAgo(c.createdAt)}</span>
                      {c.resolved && <span className="text-[9px] uppercase tracking-wide text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded shrink-0">resolved</span>}
                    </div>
                    <p className={`text-sm mt-0.5 line-clamp-2 break-words ${c.resolved ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-700 dark:text-gray-200'}`}>{c.body}</p>
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
