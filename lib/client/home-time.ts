/**
 * Relative "last edited" time for the home screen, in the UI language
 * (Intl.RelativeTimeFormat with the locale's BCP-47 tag from DATE_LOCALE), so
 * Dutch reads "5 minuten geleden" instead of a hard-coded "5m ago".
 */

/** The server sends UTC timestamps without a zone suffix; treat those as UTC. */
export function parseServerDate(value: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

export interface RelativeTimeLabels {
  never: string;
  justNow: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(
  value: string | null | undefined,
  dateLocale: string,
  labels: RelativeTimeLabels,
  now: Date = new Date(),
): string {
  if (!value) return labels.never;
  const date = parseServerDate(value);
  if (Number.isNaN(date.getTime())) return labels.never;
  const diff = now.getTime() - date.getTime();
  if (diff < MINUTE) return labels.justNow;
  const rtf = new Intl.RelativeTimeFormat(dateLocale, { numeric: 'auto' });
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour');
  if (diff < 30 * DAY) return rtf.format(-Math.floor(diff / DAY), 'day');
  return date.toLocaleDateString(dateLocale, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}
