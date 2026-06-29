/**
 * Pure filtering rules for a Claude Design export — which zip entries are worth
 * keeping (the *.dc.html screens, fonts/ and assets/) vs design-process noise
 * (screenshots/, raw uploads/, PDFs, the canvas runtime). No Node/browser deps,
 * so it can run both server-side (extraction) and client-side (pre-filtering the
 * upload so only the ~useful MBs are sent).
 */

/**
 * Only `*.dc.html`, `fonts/**` and `assets/**` are useful for porting a design;
 * everything else is noise (often hundreds of MB). Matches fonts/assets at the
 * root or under a single wrapper directory.
 */
export function shouldKeep(name: string): boolean {
  if (!name || name.endsWith('/')) return false;
  if (name.includes('..')) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.dc.html')) return true;
  if (/(^|\/)fonts\//.test(name)) return true;
  if (/(^|\/)assets\//.test(name)) return true;
  return false;
}

/**
 * If every kept entry sits under one common top-level directory (a wrapper added
 * by the zip tool, e.g. `MyDesign/…`), return that prefix so it can be stripped.
 * Returns '' for a flat export (files already at the root).
 */
export function commonRootPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const firstSegs = new Set(
    names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/')) : '')),
  );
  if (firstSegs.size !== 1) return ''; // some files at root, or multiple roots
  const seg = [...firstSegs][0];
  if (!seg || seg === 'fonts' || seg === 'assets') return ''; // meaningful top-level dir
  return `${seg}/`;
}

/** Screen name from a `*.dc.html` entry (basename without the extension). */
export function screenName(entryName: string): string {
  const base = entryName.split('/').pop() ?? entryName;
  return base.replace(/\.dc\.html$/i, '');
}
