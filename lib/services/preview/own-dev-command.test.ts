import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ownFrontendDevCommand } from './start-phases';

describe('ownFrontendDevCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'own-dev-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writePreviewJson = async (config: unknown) => {
    await fs.mkdir(path.join(dir, '.claudable'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claudable', 'preview.json'), JSON.stringify(config));
  };

  it('returns the dev command for an imported repo without a root package.json', async () => {
    await writePreviewJson({ frontend: { dev: "sh -c 'cd web && npm start -- --port {PORT}'" } });
    expect(await ownFrontendDevCommand(dir)).toBe("sh -c 'cd web && npm start -- --port {PORT}'");
  });

  it('returns null when the repo has a root package.json (normal app)', async () => {
    await writePreviewJson({ frontend: { dev: 'next dev' } });
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    expect(await ownFrontendDevCommand(dir)).toBeNull();
  });

  it('returns null without a preview.json or without frontend.dev', async () => {
    expect(await ownFrontendDevCommand(dir)).toBeNull();
    await writePreviewJson({ frontend: { memory: '2g' } });
    expect(await ownFrontendDevCommand(dir)).toBeNull();
  });
});
