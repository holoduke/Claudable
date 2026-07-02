import { signIn } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="font-grotesk relative min-h-screen overflow-hidden bg-[#0b0908] text-white flex items-center justify-center px-6">
      {/* Animated warm blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-24 h-[42rem] w-[42rem] rounded-full blur-[120px] opacity-40"
             style={{ background: 'radial-gradient(circle at 30% 30%, #DE7356, transparent 70%)', animation: 'loginBlob 18s ease-in-out infinite' }} />
        <div className="absolute top-1/3 -right-32 h-[38rem] w-[38rem] rounded-full blur-[120px] opacity-35"
             style={{ background: 'radial-gradient(circle at 60% 40%, #E8A87C, transparent 70%)', animation: 'loginBlob 22s ease-in-out infinite reverse' }} />
        <div className="absolute -bottom-40 left-1/4 h-[36rem] w-[36rem] rounded-full blur-[130px] opacity-30"
             style={{ background: 'radial-gradient(circle at 50% 50%, #8f2f1c, transparent 70%)', animation: 'loginBlob 26s ease-in-out infinite' }} />
        {/* Vignette */}
        <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)' }} />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full flex flex-col items-center text-center">
        <p className="font-script text-3xl text-[#E8A87C] mb-1" style={{ animation: 'loginFadeUp .7s ease-out both', animationDelay: '.05s' }}>
          welcome to
        </p>

        <h1 className="font-display leading-[0.82] tracking-tight select-none whitespace-nowrap px-4"
            style={{ animation: 'loginFadeUp .8s ease-out both', animationDelay: '.12s' }}>
          <span className="block bg-gradient-to-b from-white via-[#f4c9b3] to-[#DE7356] bg-clip-text text-transparent drop-shadow-[0_2px_30px_rgba(222,115,86,0.35)]"
                style={{ fontSize: 'clamp(3rem, 13vw, 8rem)' }}>
            CLAUDABLE
          </span>
        </h1>

        <div className="w-full max-w-md">
        <p className="mt-4 text-base text-white/60"
           style={{ animation: 'loginFadeUp .8s ease-out both', animationDelay: '.22s' }}>
          Describe it. Watch it build. Ship it.
        </p>

        {error && (
          <div className="mt-6 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 backdrop-blur"
               style={{ animation: 'loginFadeUp .5s ease-out both' }}>
            {error === 'AccessDenied'
              ? "This Google account isn't authorized for Claudable. Ask an admin to add you."
              : 'Sign-in failed. Please try again.'}
          </div>
        )}

        <form
          className="mt-10"
          style={{ animation: 'loginFadeUp .8s ease-out both', animationDelay: '.34s' }}
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <button
            type="submit"
            className="group relative mx-auto flex w-full max-w-xs items-center justify-center gap-3 overflow-hidden rounded-full border border-white/15 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white backdrop-blur-md transition-all duration-300 hover:border-[#DE7356]/60 hover:bg-white/10 hover:shadow-[0_10px_40px_-10px_rgba(222,115,86,0.6)] hover:-translate-y-0.5 active:translate-y-0"
          >
            {/* Shimmer sweep on hover */}
            <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
            <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
              <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
            </svg>
            <span className="relative">Continue with Google</span>
          </button>
          <p className="mt-4 text-xs text-white/35">Access is restricted to your organization.</p>
        </form>
        </div>
      </div>

      {/* Bottom marquee strip */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 overflow-hidden border-t border-white/5 py-3"
           style={{ animation: 'loginFadeUp 1s ease-out both', animationDelay: '.5s' }}>
        <div className="flex whitespace-nowrap" style={{ animation: 'loginMarquee 28s linear infinite', width: 'max-content' }}>
          {[0, 1].map((k) => (
            <div key={k} className="font-display flex items-center text-[13px] uppercase tracking-[0.25em] text-white/20">
              {['Design', 'Build', 'Preview', 'Deploy', 'Iterate', 'Ship', 'Review', 'Repeat'].map((w) => (
                <span key={w} className="mx-6 flex items-center gap-6">{w}<span className="text-[#DE7356]/50">✳</span></span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
