import { describe, it, expect } from 'vitest';
import { formatRelativeTime, parseServerDate } from './home-time';

const labels = { never: 'Never', justNow: 'Just now' };
const now = new Date('2026-10-05T12:00:00Z');

describe('formatRelativeTime', () => {
  it('handles missing and fresh timestamps with the given labels', () => {
    expect(formatRelativeTime(null, 'en-GB', labels, now)).toBe('Never');
    expect(formatRelativeTime('garbage', 'en-GB', labels, now)).toBe('Never');
    expect(formatRelativeTime('2026-10-05T11:59:40Z', 'en-GB', labels, now)).toBe('Just now');
  });

  it('uses the UI locale (Dutch reads "5 minuten geleden")', () => {
    expect(formatRelativeTime('2026-10-05T11:55:00Z', 'nl-NL', labels, now)).toBe('5 minuten geleden');
    expect(formatRelativeTime('2026-10-05T11:55:00Z', 'en-GB', labels, now)).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-10-05T09:00:00Z', 'de-DE', labels, now)).toBe('vor 3 Stunden');
    expect(formatRelativeTime('2026-10-02T12:00:00Z', 'fr-FR', labels, now)).toBe('il y a 3 jours');
  });

  it('falls back to a date for older items', () => {
    expect(formatRelativeTime('2025-01-15T12:00:00Z', 'en-GB', labels, now)).toBe('15 Jan 2025');
  });
});

describe('parseServerDate', () => {
  it('treats zone-less timestamps as UTC', () => {
    expect(parseServerDate('2026-10-05T11:00:00').toISOString()).toBe('2026-10-05T11:00:00.000Z');
    expect(parseServerDate('2026-10-05T11:00:00+02:00').toISOString()).toBe('2026-10-05T09:00:00.000Z');
  });
});
