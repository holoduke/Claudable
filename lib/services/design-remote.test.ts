import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';

// System under test imports fflate at module load; import lazily after env setup.
const ENV_KEY = 'CLAUDE_AI_SESSION_KEY';

describe('design-remote', () => {
  const origKey = process.env[ENV_KEY];

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = origKey;
    vi.restoreAllMocks();
  });

  it('reports disabled when the session key env var is unset', async () => {
    delete process.env[ENV_KEY];
    const { designRemoteEnabled } = await import('./design-remote');
    expect(designRemoteEnabled()).toBe(false);
  });

  it('reports enabled when the session key env var is set', async () => {
    process.env[ENV_KEY] = 'sk-test';
    const { designRemoteEnabled } = await import('./design-remote');
    expect(designRemoteEnabled()).toBe(true);
  });

  it('builds a zip from ListFiles + GetFile, base64-decoding content and skipping traversal paths', async () => {
    process.env[ENV_KEY] = 'sk-test';
    const html = '<!DOCTYPE html>\n<h1>Home</h1>';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split('/').pop();
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (method === 'ListFiles') {
        return jsonResponse({
          entries: [
            { path: 'assets', type: 'directory' },
            { path: 'Home.dc.html', type: 'file' },
            { path: '../evil.txt', type: 'file' }, // must be skipped
          ],
          total: 3,
        });
      }
      if (method === 'GetFile') {
        // Only the safe file should ever be requested.
        expect(body.path).toBe('Home.dc.html');
        return jsonResponse({ content: Buffer.from(html).toString('base64'), contentType: 'text/html' });
      }
      throw new Error(`unexpected method ${method}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { buildRemoteDesignArchive } = await import('./design-remote');
    const zip = await buildRemoteDesignArchive('d34a8e2c-3851-4fb1-9dd0-0d6a2f3eba28');
    const files = unzipSync(zip);
    const names = Object.keys(files);
    expect(names).toEqual(['Home.dc.html']); // traversal + directory excluded
    expect(Buffer.from(files['Home.dc.html']).toString('utf8')).toBe(html);
  });

  it('rejects an invalid design project id without any network call', async () => {
    process.env[ENV_KEY] = 'sk-test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { buildRemoteDesignArchive } = await import('./design-remote');
    await expect(buildRemoteDesignArchive('not a uuid!!')).rejects.toThrow(/invalid/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(obj: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
  } as Response;
}
