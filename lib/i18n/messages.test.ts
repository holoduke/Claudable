import { describe, expect, it } from 'vitest';
import { MESSAGES, LOCALES, DATE_LOCALE, DEFAULT_LOCALE } from './config';
import { en } from './messages/en';

// The locale catalogs are typed against `en`, so TypeScript already guarantees
// identical key sets. These checks cover what types cannot: placeholders that
// differ between languages (a {name} missing in one translation silently
// prints nothing), empty strings, untranslated copies, and registry drift.

const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe('i18n catalogs', () => {
  const locales = Object.keys(MESSAGES) as (keyof typeof MESSAGES)[];

  it('registry, switcher list and date-locale map agree', () => {
    expect(locales.sort()).toEqual(LOCALES.map((l) => l.code).sort());
    expect(Object.keys(DATE_LOCALE).sort()).toEqual(locales.sort());
    expect(locales).toContain(DEFAULT_LOCALE);
  });

  it('every key has the same placeholders in every language', () => {
    const problems: string[] = [];
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const expected = placeholders(en[key]);
      for (const loc of locales) {
        const got = placeholders((MESSAGES[loc] as Record<string, string>)[key] ?? '');
        if (got.join(',') !== expected.join(',')) problems.push(`${loc}:${key} has {${got}} vs en {${expected}}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no empty translations', () => {
    const empty: string[] = [];
    for (const loc of locales) {
      for (const [k, v] of Object.entries(MESSAGES[loc] as Record<string, string>)) {
        if (!v || !v.trim()) empty.push(`${loc}:${k}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('the organisation UI keys are actually translated (not English copies) in Dutch, German and French', () => {
    // Keys where an identical string across languages would be a real word
    // (e.g. "Type", "Superadmin", "Label") are allowed; the rest must differ.
    const allowSame = new Set(['common.type', 'common.label', 'role.superadmin', 'orgs.domain', 'org.credential.oauth', 'account.itops.title',
      'org.title', 'projectOrg.title', 'home.orgPicker', 'orgs.title', 'account.orgs.title', 'org.credential.tokenPlaceholder',
      'orgType.intern.short', 'orgs.typeInternal', 'common.name', 'common.by', 'org.yourRole', 'home.orgBadgeInternal', 'org.credential.title',
      'orgs.domainOptional']);
    const prefixes = ['org.', 'orgs.', 'account.', 'menu.', 'about.', 'users.', 'projectOrg.', 'role.', 'orgType.', 'audit.'];
    const copies: string[] = [];
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (!prefixes.some((p) => key.startsWith(p)) || allowSame.has(key)) continue;
      for (const loc of ['nl', 'de', 'fr'] as const) {
        if ((MESSAGES[loc] as Record<string, string>)[key] === en[key]) copies.push(`${loc}:${key}`);
      }
    }
    expect(copies).toEqual([]);
  });
});
