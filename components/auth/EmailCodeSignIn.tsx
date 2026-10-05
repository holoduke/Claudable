'use client';

/**
 * Sign in with a one-time code sent by e-mail — for people without a Google
 * account for their address. Step 1 requests a code, step 2 verifies it via the
 * Auth.js `email-code` credentials provider. All copy is translated; the
 * "open" button label (login.emailCode.open) is quoted verbatim by the invite
 * e-mail (lib/services/mail.ts), so keep the two in sync via the catalog.
 */
import React, { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useT } from '@/contexts/I18nContext';

type Step = 'closed' | 'email' | 'code';

const inputCls =
  'w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-[14px] text-white placeholder-white/30 outline-none focus:border-white/30';
const buttonCls =
  'w-full rounded-xl bg-white/90 px-4 py-2.5 text-[14px] font-medium text-gray-900 transition-colors hover:bg-white disabled:opacity-50';

/** Render a translated sentence with `{email}` replaced by a highlighted address. */
function withEmail(template: string, email: string): React.ReactNode {
  const [before, after = ''] = template.split('{email}');
  return <>{before}<span className="text-white/80">{email}</span>{after}</>;
}

/** `redirectTo` is already sanitised by the login page (safeCallbackPath). */
export default function EmailCodeSignIn({ redirectTo = '/' }: { redirectTo?: string }) {
  const t = useT();
  const [step, setStep] = useState<Step>('closed');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setError(t('login.emailCode.sendFailed'));
        return;
      }
      setStep('code');
    } catch {
      setError(t('login.emailCode.networkError'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn('email-code', { email, code, redirect: false });
      if (result?.ok && !result.error) {
        // Full reload is intentional: the new session cookie must be picked up by
        // the server-rendered auth gate and every client auth context. Keep the
        // button busy while the page navigates away.
        window.location.href = redirectTo;
        return;
      }
      setError(t('login.emailCode.invalid'));
    } catch {
      // Network failure / auth endpoint unreachable: never leave the button stuck.
      setError(t('login.emailCode.networkError'));
    }
    setBusy(false);
  };

  if (step === 'closed') {
    return (
      <button type="button" onClick={() => setStep('email')}
        className="mt-3 w-full rounded-xl border border-white/10 px-4 py-2.5 text-[13px] text-white/70 transition-colors hover:border-white/25 hover:text-white">
        {t('login.emailCode.open')}
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-2.5 text-left">
      {step === 'email' ? (
        <form onSubmit={requestCode} className="space-y-2.5">
          <label htmlFor="login-email" className="block text-[12px] text-white/50">{t('login.emailCode.emailLabel')}</label>
          <input id="login-email" type="email" required autoComplete="email" autoFocus value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder={t('login.emailCode.emailPlaceholder')} className={inputCls} />
          <button type="submit" disabled={busy || !email.trim()} className={buttonCls}>{t('login.emailCode.send')}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-2.5">
          <p className="text-[12px] leading-relaxed text-white/50">
            {withEmail(t('login.emailCode.sent'), email)}
          </p>
          <input id="login-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456"
            className={`${inputCls} text-center font-mono tracking-[0.4em]`} aria-label={t('login.emailCode.codeLabel')} />
          <button type="submit" disabled={busy || code.length !== 6} className={buttonCls}>{t('login.emailCode.submit')}</button>
          <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null); }}
            className="w-full text-[12px] text-white/40 hover:text-white/70">
            {t('login.emailCode.restart')}
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-red-300/90">{error}</p>}
    </div>
  );
}
