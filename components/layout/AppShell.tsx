"use client";
import { usePathname } from 'next/navigation';
import Header from '@/components/layout/Header';

/**
 * App chrome wrapper. Public stakeholder pages (/share/...) are standalone: no
 * Claudable header/nav, and they own the full viewport (the share page is
 * h-screen — a header above it would push it off-screen). Everything else gets
 * the normal header + <main> wrapper.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/share/')) return <>{children}</>;
  return (
    <>
      <Header />
      <main>{children}</main>
    </>
  );
}
