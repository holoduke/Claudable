"use client";
import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export interface BranchInfo {
  name: string;
  local: boolean;
  remote: boolean;
  current: boolean;
  base: boolean;
}

export interface ProjectBranchesState {
  mode: 'local' | 'remote';
  current: string;
  base: string;
  branches: BranchInfo[];
  dirty_files: number;
  agent_busy: boolean;
  repo_url: string | null;
}

export interface UseProjectBranches {
  data: ProjectBranchesState | null;
  refresh: () => Promise<void>;
  /** Run a branch action; returns the JSON body, throws Error(message) on failure. */
  act: (path: 'git/branches' | 'git/checkout' | 'git/merge', body?: Record<string, unknown>) => Promise<any>;
}

/**
 * The project's branches for the toolbar switcher and the publish panel. Loaded
 * on mount, on window focus and whenever `revision` changes (e.g. an agent turn
 * ended); `data` stays null for a project without files/repository yet, which
 * hides the switcher.
 */
export function useProjectBranches(projectId: string, revision: unknown): UseProjectBranches {
  const [data, setData] = useState<ProjectBranchesState | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/git/branches`, { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (mine !== seq.current) return; // a newer refresh won
      setData(res.ok && json?.success ? (json as ProjectBranchesState) : null);
    } catch {
      // network hiccup: keep the last known state
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const act = useCallback(async (path: 'git/branches' | 'git/checkout' | 'git/merge', body?: Record<string, unknown>) => {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.message || `Request failed (${res.status})`);
    return json;
  }, [projectId]);

  return { data, refresh, act };
}
