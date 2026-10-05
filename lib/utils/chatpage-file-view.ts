/**
 * Code-editor safety helpers: decide when a file must be shown read-only so a
 * failed load or a binary file can never be saved back over the real file.
 */

const BINARY_EXTENSIONS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'heic', 'psd',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // archives
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz',
  // media / documents / binaries
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi', 'pdf', 'exe', 'dll', 'so', 'dylib',
  'wasm', 'class', 'jar', 'bin', 'db', 'sqlite', 'sqlite3', 'node',
]);

export function isBinaryPath(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** NUL bytes never occur in real text files; a decoded binary usually has them. */
export function looksBinaryContent(content: string): boolean {
  return content.includes('\u0000');
}

export type FileLock =
  | { kind: 'error'; message: string }
  | { kind: 'binary' }
  | { kind: 'readonly' };

/** Placeholder text shown in the (locked) editor for a lock. */
export function lockPlaceholder(lock: FileLock, labels: { error: (m: string) => string; binary: string }): string | null {
  if (lock.kind === 'error') return labels.error(lock.message);
  if (lock.kind === 'binary') return labels.binary;
  return null;
}
