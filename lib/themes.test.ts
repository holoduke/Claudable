import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { THEMES, DEFAULT_THEME_ID, isThemeId } from './themes';
import { en } from './i18n/messages/en';

describe('theme registry', () => {
  it('has 12 themes with unique ids and light as the default', () => {
    expect(THEMES).toHaveLength(12);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(DEFAULT_THEME_ID).toBe('light');
  });

  it('every theme name key exists in the en messages', () => {
    for (const theme of THEMES) {
      expect(en[theme.nameKey], theme.nameKey).toBeTruthy();
    }
  });

  it('palette blocks in globals.css match the registry exactly', () => {
    const css = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf-8');
    for (const theme of THEMES) {
      const hasBlock = css.includes(`[data-theme='${theme.id}']`);
      expect(hasBlock, `${theme.id} block`).toBe(theme.hasPaletteBlock);
    }
    // No orphaned blocks for unknown ids.
    const blockIds = [...css.matchAll(/\[data-theme='([a-z]+)'\]/g)].map((m) => m[1]);
    for (const id of blockIds) {
      expect(isThemeId(id), `orphan block ${id}`).toBe(true);
    }
  });

  it('the layout no-flash map mirrors every theme id and mode', () => {
    const layout = fs.readFileSync(path.join(__dirname, '../app/layout.tsx'), 'utf-8');
    for (const theme of THEMES) {
      const expected = `${theme.id}:${theme.mode === 'dark' ? 1 : 0}`;
      expect(layout, expected).toContain(expected);
    }
  });

  it('validates theme ids', () => {
    expect(isThemeId('cyberpunk')).toBe(true);
    expect(isThemeId('light')).toBe(true);
    expect(isThemeId('claudable')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});
