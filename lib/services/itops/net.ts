/**
 * Network safety helpers for the it-ops broker.
 *
 * The agent controls some tool arguments (e.g. infra_health's host), so any tool
 * that opens a connection must refuse internal/loopback/link-local targets — else
 * it becomes an SSRF recon primitive (IMDS at 169.254.169.254, localhost services,
 * RFC-1918 hosts). This is a literal-IP + common-name check; it does NOT resolve
 * DNS, so a public hostname that points at a private IP is residual risk.
 */
export function isBlockedHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 loopback / link-local / unique-local
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;            // unspecified / loopback / private
    if (a === 169 && b === 254) return true;                       // link-local + AWS IMDS
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 192 && b === 168) return true;                       // private
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
  }
  return false;
}

/** fetch() with a hard timeout so an unreachable service can't stall the agent. */
export function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
