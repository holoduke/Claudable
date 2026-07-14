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
        {/* Set the theme class before paint to avoid a light flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('claudable-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`,
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
