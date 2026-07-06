"use client";
/**
 * First-open nudge: a signed-in user without a connected Claude account gets a
 * dismissible popup explaining how to connect their own `claude setup-token`.
 * Their agent runs then automatically bill their own subscription (see
 * resolveProjectClaudeToken). Dismissal is remembered per browser; the Claude
 * tab in Settings remains available any time.
 */
import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
const DISMISS_KEY = 'claudable-connect-claude-dismissed';

export default function ConnectClaudePrompt() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch { /* storage blocked — behave as not dismissed */ }
    fetch(`${API_BASE}/api/claude-credentials`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.success || !Array.isArray(j.data)) return;
        const hasOwn = j.data.some((c: { isMine?: boolean }) => c.isMine);
        if (!hasOwn) setOpen(true);
      })
      .catch(() => { /* signed out / auth off — no nudge */ });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* best-effort */ }
    setOpen(false);
  }, []);

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/claude-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), label: label.trim() || 'My Claude' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.message || 'Failed to connect');
      setDone(true);
      setTimeout(() => setOpen(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-white/[0.08] shadow-2xl p-6 space-y-4">
        {done ? (
          <div className="text-center py-4">
            <div className="text-3xl mb-2">✅</div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-50">
              Claude account connected — your agent runs now use your own subscription.
            </p>
          </div>
        ) : (
          <>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50">Connect your Claude account</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Claudable runs the coding agent on a Claude subscription. Connect your own so your work
                uses your account — otherwise it falls back to the shared platform one.
              </p>
            </div>
            <ol className="text-sm text-gray-600 dark:text-gray-300 space-y-1 list-decimal list-inside">
              <li>On your own machine, run <code className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.06] text-[13px]">claude setup-token</code></li>
              <li>Paste the token (starts with <code className="px-1 rounded bg-gray-100 dark:bg-white/[0.06] text-[13px]">sk-ant-oat…</code>) below</li>
            </ol>
            <div className="space-y-2">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. your name)"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.06] text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#DE7356]/40"
              />
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="sk-ant-oat…"
                type="password"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.06] text-sm font-mono text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#DE7356]/40"
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={dismiss}
                className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
              >
                Maybe later
              </button>
              <button
                onClick={connect}
                disabled={busy || !token.trim()}
                className="px-4 py-2 text-sm font-medium bg-[#DE7356] hover:bg-[#c9634a] text-white rounded-lg disabled:opacity-50"
              >
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              You can always do this later under Settings → Claude.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
