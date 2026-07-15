import { describe, expect, it } from 'vitest';
import { MESSAGES, LOCALES, DEFAULT_LOCALE, isLocale } from './config';
import { en } from './messages/en';

const enKeys = Object.keys(en).sort();

describe('i18n catalogs', () => {
  it('every locale defines exactly the English keys (no missing / no extra)', () => {
    for (const [code, table] of Object.entries(MESSAGES)) {
      const keys = Object.keys(table).sort();
      const missing = enKeys.filter((k) => !(k in table));
      const extra = keys.filter((k) => !(k in en));
      expect(missing, `${code} is missing keys`).toEqual([]);
      expect(extra, `${code} has unknown keys`).toEqual([]);
    }
  });

  it('no translation is empty/whitespace', () => {
    for (const [code, table] of Object.entries(MESSAGES)) {
      for (const [key, value] of Object.entries(table)) {
        expect((value ?? '').trim().length, `${code}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('LOCALES matches the message tables and includes the default + 8 languages', () => {
    const localeCodes = LOCALES.map((l) => l.code).sort();
    expect(localeCodes).toEqual(Object.keys(MESSAGES).sort());
    expect(LOCALES.length).toBeGreaterThanOrEqual(8);
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
    // every switcher entry has a human label + flag
    for (const l of LOCALES) {
      expect(l.label.trim().length).toBeGreaterThan(0);
      expect(l.flag.trim().length).toBeGreaterThan(0);
    }
  });

  it('isLocale accepts known codes and rejects junk', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('nl')).toBe(true);
    expect(isLocale('xx')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
