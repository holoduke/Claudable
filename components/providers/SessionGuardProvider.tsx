"use client";
import { useEffect } from 'react';
import { installSessionGuard } from '@/lib/client/session-guard';

/**
 * Installs the global session-expiry guard once per page load (see
 * lib/client/session-guard.ts). Renders nothing; it is a no-op while the auth
 * gate is off.
 */
export default function SessionGuardProvider() {
  useEffect(() => installSessionGuard(window), []);
  return null;
}
