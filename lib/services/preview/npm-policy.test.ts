import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureNpmPolicyFile, npmPolicyRc, NPM_ALLOW_SCRIPTS } from './npm-policy';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'npmpolicy-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('npm policy', () => {
  it('is a single allow-scripts line of plain package names', () => {
    const line = npmPolicyRc().split('\n').find((l) => l.startsWith('allow-scripts='))!;
    expect(line.slice('allow-scripts='.length).split(',')).toEqual(NPM_ALLOW_SCRIPTS);
    for (const n of NPM_ALLOW_SCRIPTS) expect(n).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/);
  });
  it('writes the file once and rewrites it only when it differs', async () => {
    const file = await ensureNpmPolicyFile(ROOT);
    expect(fs.readFileSync(file, 'utf8')).toBe(npmPolicyRc());
    fs.writeFileSync(file, 'tampered');
    await ensureNpmPolicyFile(ROOT);
    expect(fs.readFileSync(file, 'utf8')).toBe(npmPolicyRc());
  });
});
