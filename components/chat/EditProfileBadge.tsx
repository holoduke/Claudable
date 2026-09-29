"use client";
import { useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface MyProfile { id: string; label: string; description: string; kinds: string[] }

/** Shows the signed-in person's edit profile above the chat input when it is restricted. */
export default function EditProfileBadge({ projectId }: { projectId: string }) {
  const [profile, setProfile] = useState<MyProfile | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/projects/${projectId}/edit-profiles`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.success) return;
        const p = j.data?.me?.profile as MyProfile | undefined;
        setProfile(p && p.id !== 'full' ? p : null);
      })
      .catch(() => { /* badge is informational; the server enforces the profile */ });
    return () => { cancelled = true; };
  }, [projectId]);

  if (!profile) return null;
  return (
    <div className="flex mb-1.5">
      <span
        title={`${profile.description} Changes outside this profile are blocked or undone automatically.`}
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        Edit profile: {profile.label}
      </span>
    </div>
  );
}
