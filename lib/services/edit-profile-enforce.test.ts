import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/services/tenant-policy', () => ({ isCustomerProject: async () => false, isInternalUser: async () => false }));
const notices: string[] = [];
vi.mock('@/lib/services/message', () => ({
  createMessage: async (m: { content: string }) => { notices.push(m.content); return { ...m, id: 'm1', createdAt: new Date() }; },
}));
vi.mock('@/lib/services/stream', () => ({ streamManager: { publish: () => {} } }));
vi.mock('@/lib/serializers/chat', () => ({ serializeMessage: (m: unknown) => m }));

let tmp: string;
let projectPath: string;
let mod: typeof import('./edit-profile-enforce');
let profiles: typeof import('./edit-profiles');
let checkpoints: typeof import('./checkpoints');

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(projectPath, rel)), { recursive: true });
  fs.writeFileSync(path.join(projectPath, rel), content);
};
const read = (rel: string) => (fs.existsSync(path.join(projectPath, rel)) ? fs.readFileSync(path.join(projectPath, rel), 'utf8') : null);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-enforce-'));
  process.env.PROJECTS_DIR = path.join(tmp, 'projects');
  projectPath = path.join(tmp, 'projects', 'p1');
  fs.mkdirSync(projectPath, { recursive: true });
  vi.resetModules();
  checkpoints = await import('./checkpoints');
  profiles = await import('./edit-profiles');
  mod = await import('./edit-profile-enforce');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('post-turn enforcement', () => {
  it('reverts only what the profile forbids and reports it', async () => {
    write('pages/index.vue', '<template>\n  <h1 class="text-4xl">Hallo</h1>\n</template>\n');
    write('pages/about.vue', '<template><p class="p-4">Over ons</p></template>\n');
    write('content/blog.md', '# Oud\n');
    const baselineSha = await checkpoints.checkpointBaseline('p1', projectPath, 'baseline');
    expect(baselineSha).toMatch(/^[0-9a-f]{40}$/);

    // The "agent" turn: one allowed text edit, one style edit, one new component, one deletion, a lockfile.
    write('pages/index.vue', '<template>\n  <h1 class="text-4xl">Welkom</h1>\n</template>\n');
    write('pages/about.vue', '<template><p class="p-8 text-red-500">Over ons</p></template>\n');
    write('components/Evil.vue', '<script setup>fetch("/x")</script>');
    fs.rmSync(path.join(projectPath, 'content/blog.md'));
    write('package-lock.json', '{"lockfileVersion":3}');

    const guard = { projectId: 'p1', projectPath, profile: profiles.builtinProfile('content'), baselineSha };
    const violations = await mod.enforceTurnEditProfile(guard, 'r1');
    expect(violations.map((v) => v.path).sort()).toEqual(['components/Evil.vue', 'content/blog.md', 'pages/about.vue']);

    expect(read('pages/index.vue')).toContain('Welkom');              // allowed: kept
    expect(read('pages/about.vue')).toContain('class="p-4"');         // style: restored
    expect(read('components/Evil.vue')).toBeNull();                   // new code file: removed
    expect(read('content/blog.md')).toBe('# Oud\n');                  // deletion: restored
    expect(read('package-lock.json')).toBe('{"lockfileVersion":3}');  // managed file: untouched
    expect(notices.at(-1)).toMatch(/Text only/);
    expect(notices.at(-1)).toMatch(/components\/Evil\.vue/);
  });

  it('a clean turn changes nothing and posts nothing', async () => {
    const baselineSha = await checkpoints.checkpointBaseline('p1', projectPath, 'baseline 2');
    write('pages/index.vue', '<template>\n  <h1 class="text-4xl">Goedendag</h1>\n</template>\n');
    const before = notices.length;
    const violations = await mod.enforceTurnEditProfile({ projectId: 'p1', projectPath, profile: profiles.builtinProfile('content'), baselineSha }, 'r2');
    expect(violations).toEqual([]);
    expect(notices.length).toBe(before);
    expect(read('pages/index.vue')).toContain('Goedendag');
  });

  it('without a baseline it does nothing (the hook is the only layer then)', async () => {
    const violations = await mod.enforceTurnEditProfile({ projectId: 'p1', projectPath, profile: profiles.builtinProfile('content'), baselineSha: null });
    expect(violations).toEqual([]);
  });
});

describe('edit profile config', () => {
  it('parses, defaults and fails closed on corrupt config', () => {
    expect(profiles.parseEditProfileConfig(null).default).toBe('full');
    expect(profiles.parseEditProfileConfig('{"editProfiles":{"default":"style"}}').default).toBe('style');
    expect(profiles.parseEditProfileConfig('{"editProfiles":{"default":"root"}}').default).toBe('content');
    const cfg = profiles.parseEditProfileConfig('{"editProfiles":{"default":"custom","custom":{"label":"Blog","kinds":["text"],"allowPaths":["content/**"]}}}');
    const p = profiles.profileFor(cfg.default, cfg);
    expect(p).toMatchObject({ id: 'custom', label: 'Blog', kinds: ['text'], allowPaths: ['content/**'] });
    expect(profiles.isRestricted(p)).toBe(true);
    expect(profiles.profileFor('custom', { default: 'custom', members: {}, custom: null }).id).toBe('content');
  });
  it('prompt note only for restricted profiles', () => {
    expect(profiles.editProfilePromptNote(profiles.builtinProfile('full'))).toBe('');
    const note = profiles.editProfilePromptNote(profiles.builtinProfile('style'));
    expect(note).toMatch(/Edit profile: Styling only/);
    expect(note).toMatch(/Shell commands are unavailable/);
  });
  it('checkEdit for direct edits', () => {
    const content = profiles.builtinProfile('content');
    expect(profiles.checkEdit(content, 'pages/a.vue', '<p>a</p>', '<p>b</p>')).toEqual({ ok: true });
    const r = profiles.checkEdit(content, 'pages/a.vue', '<p>a</p>', '<div>a</div>');
    expect(r.ok).toBe(false);
    expect(profiles.checkEdit(profiles.builtinProfile('full'), 'x.ts', 'a', 'b')).toEqual({ ok: true });
  });
  it('guard hook settings keep hooks on', () => {
    const s = JSON.parse(profiles.guardHookSettings());
    expect(s.disableAllHooks).toBe(false);
    expect(s.hooks.PreToolUse[0].matcher).toContain('Write');
  });
});
