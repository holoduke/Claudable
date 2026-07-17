import './globals.css'
import 'highlight.js/styles/github-dark.css'
// Side-effect import (nodejs-only server component): starts the background git
// auto-sync scheduler on first server load. See auto-sync-boot for why it lives
// here and not in instrumentation.ts.
import '@/lib/services/auto-sync-boot'
import GlobalSettingsProvider from '@/contexts/GlobalSettingsContext'
import { AuthProvider } from '@/contexts/AuthContext'
import I18nProvider from '@/contexts/I18nContext'
import AppShell from '@/components/layout/AppShell'
import { ToastProvider } from '@/components/ui/Toast'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Claudable',
  description: 'Claudable Application',
  icons: {
    icon: '/Claudable_Icon.png',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the picked theme (palette + its pinned light/dark mode)
            before paint to avoid a flash. The map must match lib/themes.ts
            (guarded by lib/themes.test.ts). Falls back to the legacy
            light/dark preference for users who never picked a theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m={light:0,dark:1,midnight:1,forest:0,ocean:1,ice:0,cyberpunk:1,neon:1,ferrari:1,party:0,business:0,mono:0};var p=localStorage.getItem('claudable-palette');if(!(p in m)){var t=localStorage.getItem('claudable-theme');p=(t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}if(m[p])document.documentElement.classList.add('dark');if(p!=='light'&&p!=='dark')document.documentElement.setAttribute('data-theme',p);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-50 min-h-screen">
        <I18nProvider>
          <AuthProvider>
            <GlobalSettingsProvider>
              <ToastProvider>
                <AppShell>{children}</AppShell>
              </ToastProvider>
            </GlobalSettingsProvider>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
