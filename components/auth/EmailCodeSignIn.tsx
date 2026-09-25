'use client';

/**
 * Sign in with a one-time code sent by e-mail — for people without a Google
 * account for their address. Step 1 requests a code, step 2 verifies it via the
 * Auth.js `email-code` credentials provider.
 */
import React, { useState } from 'react';
import { signIn } from 'next-auth/react';

type Step = 'closed' | 'email' | 'code';

const inputCls =
  'w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-[14px] text-white placeholder-white/30 outline-none focus:border-white/30';
const buttonCls =
  'w-full rounded-xl bg-white/90 px-4 py-2.5 text-[14px] font-medium text-gray-900 transition-colors hover:bg-white disabled:opacity-50';

export default function EmailCodeSignIn() {
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
      await fetch('/api/auth/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setStep('code');
    } catch {
      setError('Could not send the code. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await signIn('email-code', { email, code, redirect: false });
    if (result?.ok && !result.error) {
      window.location.href = '/';
      return;
    }
    setBusy(false);
    setError('That code is not valid (anymore). Check the code or request a new one.');
  };

  if (step === 'closed') {
    return (
      <button type="button" onClick={() => setStep('email')}
        className="mt-3 w-full rounded-xl border border-white/10 px-4 py-2.5 text-[13px] text-white/70 transition-colors hover:border-white/25 hover:text-white">
        Sign in with an e-mail code
      </button>
    );
  }

  return (
    <div className="mt-4 space-y-2.5 text-left">
      {step === 'email' ? (
        <form onSubmit={requestCode} className="space-y-2.5">
          <label htmlFor="login-email" className="block text-[12px] text-white/50">Your e-mail address</label>
          <input id="login-email" type="email" required autoComplete="email" autoFocus value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={inputCls} />
          <button type="submit" disabled={busy || !email.trim()} className={buttonCls}>Send code</button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-2.5">
          <p className="text-[12px] leading-relaxed text-white/50">
            If <span className="text-white/80">{email}</span> has access, a 6-digit code is on its way. It is valid for 10 minutes.
          </p>
          <input id="login-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456"
            className={`${inputCls} text-center font-mono tracking-[0.4em]`} aria-label="Sign-in code" />
          <button type="submit" disabled={busy || code.length !== 6} className={buttonCls}>Sign in</button>
          <button type="button" onClick={() => { setStep('email'); setCode(''); setError(null); }}
            className="w-full text-[12px] text-white/40 hover:text-white/70">
            Use another address or send a new code
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-red-300/90">{error}</p>}
    </div>
  );
}
