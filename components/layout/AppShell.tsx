"use client";
import { usePathname } from 'next/navigation';
import Header from '@/components/layout/Header';

/**
 * App chrome wrapper. Standalone pages (/share/... and /login) own the full
 * viewport with no Claudable header/nav. Everything else gets the normal
 * header + <main> wrapper.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/share/') || pathname === '/login' || pathname?.startsWith('/login/')) return <>{children}</>;
  return (
    <>
      <Header />
      <main>{children}</main>
    </>
  );
}
