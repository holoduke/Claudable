"use client";
import { useEffect, useState } from 'react';
import GlobalSettings from '@/components/settings/GlobalSettings';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

/**
 * Top-right "my user" icon. Opens My User Settings (the global settings modal at
 * the "My Account" tab), where admins can enable their own it-ops tools and reach
 * User Management. Always rendered; shows the user's initial/avatar when signed in.
 */
export default function UserMenu() {
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<{ email?: string; name?: string | null; image?: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/users/me`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setMe((j?.data as any) ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  const initial = (me?.name || me?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="My account"
        aria-label="My account"
        className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
      >
        {me?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={me.image} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-semibold">{initial}</span>
        )}
      </button>
      <GlobalSettings isOpen={open} onClose={() => setOpen(false)} initialTab="account" />
    </>
  );
}
