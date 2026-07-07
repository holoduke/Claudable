/**
 * Network safety helpers for the it-ops broker.
 *
 * The agent controls some tool arguments (e.g. infra_health's host), so any tool
 * that opens a connection must refuse internal/loopback/link-local targets — else
 * it becomes an SSRF recon primitive (IMDS at 169.254.169.254, localhost services,
 * RFC-1918 hosts). `isBlockedHost` is a literal-IP + common-name check;
 * `assertHostAllowed` additionally RESOLVES the hostname and re-checks every
 * resolved IP, closing the DNS-rebinding gap (a public name pointing at a private IP).
 */
import { lookup } from 'dns/promises';

function isBlockedHost(host: string): boolean {
  let h = host.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 loopback / link-local / unique-local
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv4-mapped/compat IPv6 (e.g. ::ffff:127.0.0.1, ::127.0.0.1): unwrap to the
  // embedded IPv4 and let the IPv4 rules below catch a private/loopback target.
  const mapped = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u);
  if (mapped) h = mapped[1];
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

/**
 * Resolve `host` and throw if the literal OR any resolved IP is internal — so a
 * public hostname that resolves to 169.254.169.254 / 127.0.0.1 / an RFC-1918 host
 * is refused. Call this before any it-ops tool opens a connection to an
 * agent-supplied host.
 */
export async function assertHostAllowed(host: string): Promise<void> {
  if (isBlockedHost(host)) throw new Error(`Refusing internal/loopback host: ${host}`);
  let addrs: Array<{ address: string }> = [];
  try {
    addrs = await lookup(host.trim().replace(/^\[|\]$/gu, ''), { all: true });
  } catch {
    // Unresolvable → let the connection attempt fail naturally (nothing to SSRF).
    return;
  }
  for (const { address } of addrs) {
    if (isBlockedHost(address)) throw new Error(`Host ${host} resolves to a blocked internal address (${address}).`);
  }
}

/** fetch() with a hard timeout so an unreachable service can't stall the agent. */
export function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}
