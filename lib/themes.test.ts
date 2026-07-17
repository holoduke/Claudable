import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { THEMES, DEFAULT_THEME_ID, isThemeId } from './themes';
import { en } from './i18n/messages/en';

describe('theme registry', () => {
  it('has 5 themes with unique ids and the expected default', () => {
    expect(THEMES).toHaveLength(5);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(DEFAULT_THEME_ID).toBe('claudable');
  });

  it('every theme name key exists in the en messages', () => {
    for (const theme of THEMES) {
      expect(en[theme.nameKey], theme.nameKey).toBeTruthy();
    }
  });

  it('every non-default theme has a [data-theme] palette block in globals.css', () => {
    const css = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf-8');
    for (const theme of THEMES) {
      if (theme.id === DEFAULT_THEME_ID) continue;
      expect(css, theme.id).toContain(`[data-theme='${theme.id}']`);
    }
  });

  it('the layout no-flash whitelist covers exactly the non-default themes', () => {
    const layout = fs.readFileSync(path.join(__dirname, '../app/layout.tsx'), 'utf-8');
    for (const theme of THEMES) {
      if (theme.id === DEFAULT_THEME_ID) continue;
      expect(layout, theme.id).toContain(`'${theme.id}'`);
    }
  });

  it('validates theme ids', () => {
    expect(isThemeId('midnight')).toBe(true);
    expect(isThemeId('claudable')).toBe(true);
    expect(isThemeId('neon')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});
