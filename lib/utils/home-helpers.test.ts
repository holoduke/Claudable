import { describe, expect, it } from 'vitest';
import { apiErrorMessage, deriveProjectName, stripExtension } from './home-helpers';

describe('deriveProjectName', () => {
  it('uses the prompt, truncated to 50 chars', () => {
    expect(deriveProjectName('  A todo app  ', [], 'Untitled')).toBe('A todo app');
    expect(deriveProjectName('x'.repeat(60), [], 'Untitled')).toBe(`${'x'.repeat(50)}...`);
  });

  it('falls back to the first attachment name without extension when there is no prompt', () => {
    expect(deriveProjectName('', ['Brand guide.pdf', 'logo.png'], 'Untitled')).toBe('Brand guide');
    expect(deriveProjectName('   ', ['design.v2.fig'], 'Untitled')).toBe('design.v2');
  });

  it('falls back to the translated default when nothing usable is there', () => {
    expect(deriveProjectName('', [], 'Naamloos project')).toBe('Naamloos project');
    expect(deriveProjectName('', ['  '], 'Untitled')).toBe('Untitled');
  });
});

describe('stripExtension', () => {
  it('keeps dotfiles and extensionless names', () => {
    expect(stripExtension('.env')).toBe('.env');
    expect(stripExtension('README')).toBe('README');
    expect(stripExtension('a.tar.gz')).toBe('a.tar');
  });
});

describe('apiErrorMessage', () => {
  it('prefers message, then error, then the fallback', () => {
    expect(apiErrorMessage({ error: 'org_cannot_create', message: 'Not allowed. Ask New Story.' }, 'Failed')).toBe('Not allowed. Ask New Story.');
    expect(apiErrorMessage({ error: 'project_id and name are required' }, 'Failed')).toBe('project_id and name are required');
    expect(apiErrorMessage({ success: false }, 'Failed')).toBe('Failed');
    expect(apiErrorMessage(null, 'Failed')).toBe('Failed');
    expect(apiErrorMessage('oops', 'Failed')).toBe('Failed');
  });

  it('skips the generic 5xx placeholder message', () => {
    expect(apiErrorMessage({ error: 'Failed to create project', message: 'Internal server error' }, 'x')).toBe('Failed to create project');
  });
});
