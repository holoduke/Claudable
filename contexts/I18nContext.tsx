'use client';

/**
 * App-wide i18n. A lightweight client context (no routing/middleware changes):
 * it resolves the active locale (persisted in localStorage, else the browser
 * language, else English) and exposes t(key, vars). Missing keys fall back to
 * English, then to the key itself, so partially-migrated screens never crash.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MESSAGES, LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from '@/lib/i18n/config';
import type { MessageKey } from '@/lib/i18n/messages/en';

const STORAGE_KEY = 'claudable.locale';
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

type TFunc = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFunc;
  locales: typeof LOCALES;
}

const I18nCtx = createContext<I18nContextValue | null>(null);

export default function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // Resolve the initial locale on mount (client-only — avoids SSR hydration
  // mismatch by starting from the default and correcting after mount).
  // Priority: the signed-in user's saved locale > localStorage > browser lang.
  // The user's account setting wins so a language chosen on one device follows
  // them everywhere; localStorage gives an instant answer before the fetch.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (isLocale(stored)) setLocaleState(stored);
      else {
        const nav = (navigator.language || '').slice(0, 2).toLowerCase();
        if (isLocale(nav)) setLocaleState(nav);
      }
    } catch { /* no storage (SSR / privacy mode) */ }

    // Then reconcile with the account preference (authoritative when present).
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/users/me`, { credentials: 'include' });
        if (!res.ok) return;
        const json = await res.json();
        const accountLocale = json?.data?.locale;
        if (!cancelled && isLocale(accountLocale)) {
          setLocaleState(accountLocale);
          try { localStorage.setItem(STORAGE_KEY, accountLocale); } catch { /* noop */ }
        }
      } catch { /* not signed in / offline → keep the local guess */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try { document.documentElement.lang = locale; } catch { /* noop */ }
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* noop */ }
    // Persist to the signed-in user's account (best-effort; a guest just keeps
    // the localStorage value). 401/anon responses are fine to ignore.
    fetch(`${API_BASE}/api/users/me`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: l }),
    }).catch(() => { /* offline / not signed in */ });
  }, []);

  const t = useCallback<TFunc>((key, vars) => {
    const table = MESSAGES[locale] as Record<string, string>;
    let s = table[key] ?? (MESSAGES.en as Record<string, string>)[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return s;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t, locales: LOCALES }), [locale, setLocale, t]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

/** Convenience: just the translate function. */
export function useT(): TFunc {
  return useI18n().t;
}
