// Preview-host parsing for wake-on-visit (wake.ts). Kept free of Node imports
// because proxy.ts uses it too.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Host part of PREVIEW_URL_TEMPLATE split around {project}, or null when not per-project. */
function hostTemplate(template: string): { prefix: string; suffix: string } | null {
  const m = /^https?:\/\/([^/?#]+)/u.exec(template.trim());
  const host = m?.[1].toLowerCase() ?? '';
  const i = host.indexOf('{project}');
  if (i < 0) return null;
  const t = { prefix: host.slice(0, i), suffix: host.slice(i + '{project}'.length) };
  return /^[a-z0-9.-]*$/u.test(t.prefix + t.suffix) ? t : null;
}

/** Go/JS regex matching every preview host of this deployment (slug in group 1). */
export function wakeHostRegex(template: string): string | null {
  const t = hostTemplate(template);
  if (!t || !t.prefix) return null; // a bare {project}.domain would swallow every subdomain
  return `^${escapeRegex(t.prefix)}([a-z0-9-]+)${escapeRegex(t.suffix)}$`;
}

/** The slug of a preview host ("preview-foo.example.com" → "foo"), or null. */
export function slugFromHost(host: string | null | undefined, template: string): string | null {
  const re = wakeHostRegex(template);
  if (!re || !host) return null;
  const m = new RegExp(re, 'u').exec(host.toLowerCase().replace(/:\d+$/u, ''));
  return m ? m[1] : null;
}
