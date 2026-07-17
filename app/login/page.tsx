import { signIn } from '@/lib/auth';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import SpotlightCard from '@/components/auth/SpotlightCard';
import BrandWordmark from '@/components/ui/BrandWordmark';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in · Claudable' };

// Fine film grain (inline SVG) — the texture that makes dark UIs feel premium.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E\")";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="font-grotesk relative min-h-screen overflow-hidden bg-[#0a0807] text-white antialiased flex items-center justify-center px-5 py-10">
      {/* Aurora — soft warm gradients drifting slowly. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute left-1/2 top-[-16%] h-184 w-184 -translate-x-1/2 rounded-full blur-[140px] opacity-[0.30]"
          style={{ background: 'radial-gradient(circle at 50% 50%, var(--color-brand-500), transparent 70%)', animation: 'loginAurora 26s ease-in-out infinite' }}
        />
        <div
          className="absolute bottom-[-22%] right-[-8%] h-160 w-160 rounded-full blur-[150px] opacity-[0.20]"
          style={{ background: 'radial-gradient(circle at 50% 50%, var(--color-brand-300), transparent 70%)', animation: 'loginAurora 32s ease-in-out infinite reverse' }}
        />
        <div
          className="absolute left-[-10%] top-1/3 h-128 w-lg rounded-full blur-[150px] opacity-[0.15]"
          style={{ background: 'radial-gradient(circle at 50% 50%, var(--color-brand-800), transparent 70%)', animation: 'loginAurora 38s ease-in-out infinite' }}
        />
      </div>

      {/* Dotted grid, radially masked so it fades toward the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          maskImage: 'radial-gradient(ellipse 60% 55% at 50% 42%, black, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(ellipse 60% 55% at 50% 42%, black, transparent 78%)',
        }}
      />

      {/* Film grain + vignette. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-soft-light" style={{ backgroundImage: GRAIN }} />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 80% 80% at 50% 40%, transparent 45%, rgba(0,0,0,0.6) 100%)' }} />

      {/* Content */}
      <main className="relative z-10 w-full max-w-[380px] flex flex-col items-center text-center">
        {/* Brand lockup — real logo mark + wordmark, not a display-font headline. */}
        <div
          className="flex flex-col items-center"
          style={{ animation: 'loginFadeUp .8s ease-out both', animationDelay: '.05s' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/Claudable_Icon.png"
            alt=""
            width={56}
            height={56}
            className="themed-logo h-14 w-14 rounded-[15px] shadow-[0_10px_40px_-6px_color-mix(in_srgb,var(--color-brand-500)_55%,transparent),0_2px_8px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
          />
          <BrandWordmark
            className="mt-6 h-[30px] w-[174px]"
            style={{ background: 'linear-gradient(180deg, #ffffff 30%, var(--color-brand-200) 100%)' }}
          />
        </div>

        <p
          className="mt-4 text-[15px] text-white/45 tracking-wide"
          style={{ animation: 'loginFadeUp .8s ease-out both', animationDelay: '.16s' }}
        >
          Describe it. Watch it build. Ship it.
        </p>

        {/* Sign-in card */}
        <SpotlightCard
          className="mt-9 w-full p-7"
          style={{ animation: 'loginFadeUp .8s ease-out both', animationDelay: '.26s' }}
        >
          <h1 className="text-[17px] font-semibold tracking-tight text-white/95">Welcome back</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/40">
            Sign in with your organization&rsquo;s Google account.
          </p>

          {error && (
            <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-red-400/25 bg-red-500/8 px-3.5 py-3 text-left text-[13px] text-red-200/90">
              <svg className="mt-px h-4 w-4 shrink-0 text-red-300" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 8v5m0 3h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>
                {error === 'AccessDenied'
                  ? "This Google account isn't authorized for Claudable. Ask an admin to add you."
                  : 'Sign-in failed. Please try again.'}
              </span>
            </div>
          )}

          <form
            className="mt-6"
            action={async () => {
              'use server';
              await signIn('google', { redirectTo: '/' });
            }}
          >
            <GoogleSignInButton />
          </form>

          <div className="mt-6 border-t border-white/6 pt-4">
            <div className="flex items-center justify-center gap-1.5 text-[12px] text-white/30">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              <span>Access restricted to your organization</span>
            </div>
          </div>
        </SpotlightCard>

        <p
          className="mt-8 text-[11px] uppercase tracking-[0.28em] text-white/20"
          style={{ animation: 'loginFadeUp 1s ease-out both', animationDelay: '.4s' }}
        >
          Self-hosted · Powered by Claude
        </p>
      </main>
    </div>
  );
}
