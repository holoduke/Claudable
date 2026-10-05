import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DesignImportError, readStagedDesignUpload, tooLargeError } from './design-import';

const UUID = '0b6f6a4e-3c1d-4e5f-9a7b-1c2d3e4f5a6b';
let root: string;
let projectDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-upload-'));
  projectDir = path.join(root, 'proj');
  await fs.mkdir(path.join(projectDir, 'assets'), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'ok'; } catch (e) { return e instanceof DesignImportError ? e.code : String(e); }
};

describe('readStagedDesignUpload (chunk-uploaded design zip)', () => {
  it('reads a staged assets/<uuid>.zip', async () => {
    await fs.writeFile(path.join(projectDir, 'assets', `${UUID}.zip`), 'zipbytes');
    const { bytes, absolutePath } = await readStagedDesignUpload(projectDir, `assets/${UUID}.zip`);
    expect(Buffer.from(bytes).toString()).toBe('zipbytes');
    expect(absolutePath.endsWith(`${UUID}.zip`)).toBe(true);
  });

  it('rejects anything that is not an upload reference (traversal, other dirs, other types)', async () => {
    for (const bad of ['../x.zip', `assets/../../${UUID}.zip`, `src/${UUID}.zip`, `assets/${UUID}.txt`, 'assets/design.zip', 42, null]) {
      expect(await codeOf(readStagedDesignUpload(projectDir, bad))).toBe('invalid_upload');
    }
  });

  it('a missing file or a symlink out of assets/ is not found', async () => {
    expect(await codeOf(readStagedDesignUpload(projectDir, `assets/${UUID}.zip`))).toBe('upload_missing');
    const secret = path.join(root, 'secret.zip');
    await fs.writeFile(secret, 'secret');
    await fs.symlink(secret, path.join(projectDir, 'assets', `${UUID}.zip`));
    expect(await codeOf(readStagedDesignUpload(projectDir, `assets/${UUID}.zip`))).toBe('upload_missing');
  });

  it('the size error carries MB params for a meaningful message', () => {
    const err = tooLargeError(700 * 1024 * 1024);
    expect(err.code).toBe('too_large');
    expect(err.params).toEqual({ size: 700, limit: 600 });
  });
});
