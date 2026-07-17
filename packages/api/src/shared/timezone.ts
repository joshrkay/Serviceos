export const VALID_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Boise',
  'UTC',
] as const;

export type SupportedTimezone = (typeof VALID_TIMEZONES)[number];

export function isValidTimezone(timezone: string): timezone is SupportedTimezone {
  return VALID_TIMEZONES.includes(timezone as SupportedTimezone);
}

const dateKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The 'YYYY-MM-DD' calendar day `instant` falls on IN THE GIVEN IANA tz.
 * Derived from `Intl` wall-clock parts, NOT `toISOString().slice(0,10)`
 * (which keys off UTC and mis-buckets instants near the tenant's midnight —
 * an 11 PM America/Los_Angeles appointment is the NEXT UTC day). Falls back
 * to the UTC date for an unsupported tz, matching `addCalendarDays`.
 */
export function localDateKey(instant: Date, tz: string): string {
  if (!isValidTimezone(tz)) return instant.toISOString().slice(0, 10);
  let f = dateKeyFormatterCache.get(tz);
  if (!f) {
    // en-CA renders as 'YYYY-MM-DD'.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateKeyFormatterCache.set(tz, f);
  }
  return f.format(instant);
}

const wallClockFormatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(tz: string): Intl.DateTimeFormat {
  let f = wallClockFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    wallClockFormatterCache.set(tz, f);
  }
  return f;
}

function wallClockMs(d: Date, tz: string): number {
  const parts = wallClockFormatter(tz)
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  return Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
}

/**
 * Return the UTC instant corresponding to 00:00:00 local time on
 * `yyyymmdd` (YYYY-MM-DD) in the given IANA tz. Throws on a malformed
 * date string. Falls back to UTC midnight if `tz` is invalid.
 *
 * Why we need this: parsing `new Date('2026-05-04T00:00:00Z')` gives
 * UTC midnight, which is Sunday 17:00 in America/Los_Angeles — the
 * weekly rollup window slides into the wrong week. Use this helper
 * for any "start of day in tenant tz" calculation.
 */
export function tzMidnight(yyyymmdd: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) throw new Error(`tzMidnight: invalid date '${yyyymmdd}'`);
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const probeUtc = Date.UTC(y, mo - 1, d, 0, 0, 0);
  if (!isValidTimezone(tz)) return new Date(probeUtc);
  // Probe the offset by asking what wall-clock the probe represents in tz.
  const offsetMs = wallClockMs(new Date(probeUtc), tz) - probeUtc;
  return new Date(probeUtc - offsetMs);
}

/**
 * DST-safe calendar add. Given a UTC instant that is midnight in `tz`,
 * return the UTC instant that is midnight in `tz` `days` later. Adding
 * a fixed `days * 24h` is wrong on DST transitions (a calendar week
 * may be 167 or 169 hours).
 */
export function addCalendarDays(date: Date, days: number, tz: string): Date {
  if (!isValidTimezone(tz)) {
    return new Date(date.getTime() + days * 86_400_000);
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const ymd = fmt.format(date);
  const [y, mo, d] = ymd.split('-').map(Number);
  const nextUtc = Date.UTC(y, mo - 1, d + days);
  const nextYmd = new Date(nextUtc).toISOString().slice(0, 10);
  return tzMidnight(nextYmd, tz);
}
