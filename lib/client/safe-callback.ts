/**
 * Where to go after signing in. Only same-site paths are accepted — never
 * `//host`, `/\host`, a scheme or an encoded variant — so a crafted
 * `/login?callbackUrl=` can't bounce a fresh session to another site.
 */
export function safeCallbackPath(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string') return fallback;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return fallback;
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return fallback;
  return value.slice(0, 1000);
}
