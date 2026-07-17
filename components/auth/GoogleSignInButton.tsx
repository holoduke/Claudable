'use client';

import { useFormStatus } from 'react-dom';

/**
 * The Google sign-in button. A client component so it can reflect the form's
 * pending state (spinner + disabled) via useFormStatus — it lives inside the
 * server-action <form> on the login page.
 */
export default function GoogleSignInButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-white px-5 py-3 text-[15px] font-medium text-[#1f1f1f] shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-200 hover:shadow-[0_8px_30px_-8px_color-mix(in_srgb,var(--color-brand-500)_55%,transparent)] hover:-translate-y-px focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-80"
    >
      {/* Sheen sweep on hover */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-black/4 to-transparent transition-transform duration-700 group-hover:translate-x-full"
      />
      {pending ? (
        <>
          <svg className="h-[18px] w-[18px] animate-spin text-brand-500" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-20" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <span className="relative">Connecting to Google…</span>
        </>
      ) : (
        <>
          <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" aria-hidden>
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
          </svg>
          <span className="relative">Continue with Google</span>
        </>
      )}
    </button>
  );
}
