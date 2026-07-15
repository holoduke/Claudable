/**
 * Client-side chunked file upload to a project's assets.
 *
 * Chunking is REQUIRED: the Next server and fronting proxies (Traefik) cap a
 * single request body at ~10MB, so a one-shot multipart POST silently fails for
 * anything larger (e.g. a real zip). The chunks of one file share an uploadId;
 * the server appends them and the last one finalizes into assets/. This is the
 * only upload path that survives large files — used by BOTH the chat composer
 * and the new-project screen so attachments behave the same before and after
 * project creation.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB — comfortably under the ~10MB body cap

/** The finalize response from POST /api/assets/:id/upload. */
export interface UploadResult {
  success?: boolean;
  path?: string; // "assets/<uuid><ext>" — the in-project reference path
  absolute_path?: string;
  filename?: string;
  original_filename?: string;
  public_path?: string | null;
  public_url?: string | null;
}

/**
 * Upload one file to `projectId`'s assets in sub-limit chunks via XHR (XHR gives
 * upload progress, which fetch can't). Resolves with the finalize response;
 * rejects with a message-bearing Error on any chunk failure.
 */
export function uploadFileChunked(
  projectId: string,
  file: File,
  opts?: { onProgress?: (pct: number) => void },
): Promise<UploadResult> {
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const uploadId = crypto.randomUUID();

  const sendChunk = (i: number): Promise<UploadResult> =>
    new Promise((resolve, reject) => {
      const start = i * CHUNK_SIZE;
      const blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
      const xhr = new XMLHttpRequest();
      const qs =
        `filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}` +
        `&uploadId=${uploadId}&chunkIndex=${i}&chunks=${total}`;
      xhr.open('POST', `${API_BASE}/api/assets/${projectId}/upload?${qs}`);
      // Same-origin XHR sends the session cookie automatically (auth gate relies
      // on it) — no Authorization header needed.
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && opts?.onProgress) {
          const overall = Math.round(((start + ev.loaded) / Math.max(1, file.size)) * 100);
          opts.onProgress(Math.min(100, overall));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('Bad server response')); }
        } else {
          let msg = `${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep status */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(blob);
    });

  return (async () => {
    let last: UploadResult = {};
    for (let i = 0; i < total; i++) last = await sendChunk(i); // in order
    return last;
  })();
}
