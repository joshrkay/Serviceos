/**
 * Converts a date-like input into a Date object anchored to its UTC instant.
 *
 * JavaScript Date always represents an absolute instant; this helper ensures
 * we always persist normalized Date instances (never raw strings / local forms).
 */
export function toUtcDate(input: Date | string): Date {
  const parsed = input instanceof Date ? new Date(input.getTime()) : new Date(input);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date value');
  }

  return new Date(parsed.toISOString());
}

/**
 * Day of week (0=Sunday..6=Saturday) of `date` as observed in `timezone`.
 *
 * A UTC instant can fall on a different calendar day depending on the zone,
 * so callers that match against per-day records (e.g. working hours) must
 * resolve the weekday in the relevant local zone rather than via getUTCDay().
 */
export function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const day = Number(parts.find((p) => p.type === 'day')!.value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

