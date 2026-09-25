/**
 * USD → EUR conversion for the credits ledger. Agent costs are reported in USD
 * (the CLI's list-price estimate); organisation budgets are in EUR.
 *
 * Source: the ECB daily reference rate (public, no key), cached for 12 hours.
 * On failure the last known rate is used, else USD_EUR_RATE from the env, else a
 * conservative default.
 */
const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const CACHE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_EUR_PER_USD = 0.9;

let cached: { eurPerUsd: number; fetchedAt: number } | null = null;

/** Parse "EUR per USD" out of the ECB daily XML (which lists USD per EUR). */
export function parseEcbEurPerUsd(xml: string): number | null {
  const match = xml.match(/currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/);
  const usdPerEur = match ? Number(match[1]) : NaN;
  return Number.isFinite(usdPerEur) && usdPerEur > 0 ? 1 / usdPerEur : null;
}

function fallbackRate(): number {
  const fromEnv = Number(process.env.USD_EUR_RATE);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_EUR_PER_USD;
}

/** Current EUR per 1 USD. Never throws. */
export async function eurPerUsd(): Promise<number> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.eurPerUsd;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(ECB_DAILY_URL, { signal: controller.signal }).finally(() => clearTimeout(timer));
    const rate = res.ok ? parseEcbEurPerUsd(await res.text()) : null;
    if (rate) {
      cached = { eurPerUsd: rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch (error) {
    console.warn('[fx] ECB rate unavailable, using fallback:', error instanceof Error ? error.message : error);
  }
  return cached?.eurPerUsd ?? fallbackRate();
}

export async function usdToEurCents(usd: number): Promise<number> {
  return Math.round(usd * (await eurPerUsd()) * 100);
}

export async function eurCentsToUsd(cents: number): Promise<number> {
  return cents / 100 / (await eurPerUsd());
}
