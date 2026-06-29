/**
 * Which third-party integrations are surfaced in the UI.
 *
 * Vercel and Supabase are hidden for the self-hosted setup: deploys run through
 * the built-in Git/CI pipeline (not Vercel) and persistence is SQLite (not
 * Supabase), so neither is needed. Hiding them here removes their cards/tokens
 * from Settings without ripping out the underlying API routes — flip the list to
 * re-enable.
 */
export const HIDDEN_INTEGRATIONS: readonly string[] = ['vercel', 'supabase'];

export function isIntegrationVisible(id: string): boolean {
  return !HIDDEN_INTEGRATIONS.includes(id);
}
