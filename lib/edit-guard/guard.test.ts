import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateEdit, readTextOrNull } = require('./guard.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PROFILES } = require('./classify.cjs');

let root: string;
const page = '<template>\n  <h1 class="text-4xl">Hallo</h1>\n</template>\n';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-guard-'));
  fs.mkdirSync(path.join(root, 'pages'));
  fs.writeFileSync(path.join(root, 'pages/index.vue'), page);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (profile: unknown, toolName: string, toolInput: Record<string, unknown>) =>
  evaluateEdit({ profile, root, toolName, toolInput, readFile: readTextOrNull });

describe('evaluateEdit', () => {
  it('content profile: text edit allowed, class edit denied', () => {
    const file = path.join(root, 'pages/index.vue');
    expect(run(PROFILES.content, 'Edit', { file_path: file, old_string: 'Hallo', new_string: 'Welkom' })).toBeNull();
    const reason = run(PROFILES.content, 'Edit', { file_path: file, old_string: 'text-4xl', new_string: 'text-5xl' });
    expect(reason).toMatch(/edit profile/);
    expect(reason).toMatch(/styling/);
  });
  it('style profile: MultiEdit with only class changes is allowed', () => {
    const file = path.join(root, 'pages/index.vue');
    expect(run(PROFILES.style, 'MultiEdit', { file_path: file, edits: [{ old_string: 'text-4xl', new_string: 'text-6xl text-red-600' }] })).toBeNull();
    expect(run(PROFILES.style, 'MultiEdit', { file_path: file, edits: [{ old_string: 'Hallo', new_string: 'Hoi' }] })).not.toBeNull();
  });
  it('Write of a whole file is classified against the current content', () => {
    const file = path.join(root, 'pages/index.vue');
    expect(run(PROFILES.content, 'Write', { file_path: file, content: page.replace('Hallo', 'Dag') })).toBeNull();
    expect(run(PROFILES.content, 'Write', { file_path: file, content: page.replace('<h1', '<h1 v-if="x"') })).not.toBeNull();
  });
  it('new code files, paths outside the project and notebooks are denied', () => {
    expect(run(PROFILES.content, 'Write', { file_path: path.join(root, 'components/X.vue'), content: '<p/>' })).not.toBeNull();
    expect(run(PROFILES.content, 'Write', { file_path: '/etc/passwd', content: 'x' })).toMatch(/inside the project/);
    expect(run(PROFILES.content, 'Edit', { file_path: path.join(root, '../x.vue'), old_string: 'a', new_string: 'b' })).toMatch(/inside the project/);
    expect(run(PROFILES.content, 'NotebookEdit', { notebook_path: 'a.ipynb' })).not.toBeNull();
  });
  it('symlink escape is denied', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-guard-out-'));
    fs.writeFileSync(path.join(outside, 'a.md'), '# x');
    fs.symlinkSync(outside, path.join(root, 'content'));
    expect(run(PROFILES.content, 'Write', { file_path: path.join(root, 'content/a.md'), content: '# y' })).toMatch(/inside the project/);
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it('full profile and non-edit tools pass; missing profile fails closed', () => {
    expect(run(PROFILES.full, 'Write', { file_path: '/etc/x', content: 'x' })).toBeNull();
    expect(run(PROFILES.content, 'Read', { file_path: '/etc/passwd' })).toBeNull();
    expect(run(null, 'Write', { file_path: path.join(root, 'a.md'), content: 'x' })).toMatch(/could not be read/);
  });
});

describe('guard.cjs as a CLI hook', () => {
  const hook = (profile: string | undefined, input: unknown) =>
    spawnSync(process.execPath, [path.join(__dirname, 'guard.cjs')], {
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDABLE_EDIT_PROFILE: profile, CLAUDABLE_EDIT_ROOT: root },
      encoding: 'utf8',
    });

  it('prints a deny decision for a forbidden edit and nothing for an allowed one', () => {
    const file = path.join(root, 'pages/index.vue');
    const denied = hook(JSON.stringify(PROFILES.content), { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'text-4xl', new_string: 'text-2xl' } });
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const ok = hook(JSON.stringify(PROFILES.content), { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'Hallo', new_string: 'Hey' } });
    expect(ok.stdout).toBe('');
  });
  it('a corrupt profile env denies', () => {
    const r = hook('{not json', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'a.md'), content: 'x' } });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
