/**
 * Tenant-timezone-aware date formatting.
 *
 * CLAUDE.md core pattern: "All times: stored UTC, rendered in tenant
 * timezone". The browser default — `new Date(iso).toLocaleString()` —
 * renders in the VIEWER's browser-local timezone, which is wrong for a
 * dispatcher in NYC looking at an appointment scheduled for a customer
 * in PST: the dispatcher sees 4 PM when the appointment is at 1 PM
 * tenant-local. This module routes every date display through the
 * tenant's IANA timezone (sourced from `/api/me` and surfaced via
 * `useTenantTimezone`).
 *
 * All formatters use `Intl.DateTimeFormat` with an explicit `timeZone`
 * option, so the same instant renders the same way for every viewer of
 * the same tenant regardless of their browser locale.
 */

export interface FormatInTenantTzOptions extends Intl.DateTimeFormatOptions {
  /** Defaults to `en-US`; mirrors the existing call sites' locale choice. */
  locale?: string;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Format an instant in the tenant's local time. The `options` shape is
 * the same as `Intl.DateTimeFormat`; `timeZone` is overridden with the
 * tenant's value (callers should not pass it themselves).
 */
export function formatInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: FormatInTenantTzOptions = {},
): string {
  const { locale = 'en-US', ...intlOptions } = options;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { ...intlOptions, timeZone: timezone }).format(d);
}

/** Convenience: "Apr 28" / "Apr 28, 2026". */
export function formatDateInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: { withYear?: boolean; locale?: string } = {},
): string {
  return formatInTenantTz(value, timezone, {
    locale: options.locale,
    month: 'short',
    day: 'numeric',
    year: options.withYear ? 'numeric' : undefined,
  });
}

/** Convenience: "1:30 PM". */
export function formatTimeInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: { locale?: string } = {},
): string {
  return formatInTenantTz(value, timezone, {
    locale: options.locale,
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * INVERSE of the formatters above: interpret a wall-clock date + time as
 * TENANT-local and return the UTC instant.
 *
 * CLAUDE.md core pattern, input side: "stored UTC, rendered in tenant
 * timezone" also means times ENTERED in the UI are tenant-local wall clock.
 * `new Date('YYYY-MM-DDTHH:mm')` interprets the string in the BROWSER's
 * timezone, so a dispatcher in a different zone (or a UTC CI browser)
 * posted the wrong instant — journey QA 2026-07-02 bug 4: 14:00 entered
 * on the schedule page was stored as 14:00 UTC and rendered as 10:00 AM
 * tenant time.
 *
 * Implementation: no tz database in the browser beyond Intl, so we invert
 * `Intl.DateTimeFormat` numerically — guess the instant as if the wall
 * clock were UTC, measure the tenant-zone offset at that guess, adjust,
 * and re-measure once (the second pass converges across DST boundaries).
 * For a nonexistent wall-clock time (spring-forward gap) this lands on a
 * nearby valid instant rather than throwing.
 */
export function tenantWallClockToUtc(
  date: string, // 'YYYY-MM-DD'
  time: string, // 'HH:mm' (seconds optional)
  timezone: string,
): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = time.split(':').map(Number);
  if (
    [y, mo, d, h, mi, s].some((n) => Number.isNaN(n)) ||
    y === undefined || mo === undefined || d === undefined
  ) {
    return new Date(NaN);
  }

  const wallClockAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);

  // Offset (ms) of `timezone` from UTC at the given instant: render the
  // instant in the zone and re-read the rendered wall clock as UTC.
  const offsetAt = (ts: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (type: string): number =>
      Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const rendered = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      // Intl renders midnight as '24' with hour12:false in some engines.
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return rendered - ts;
  };

  let ts = wallClockAsUtc - offsetAt(wallClockAsUtc);
  // Second pass: if the first guess crossed a DST transition, the offset at
  // the corrected instant may differ — re-derive against it.
  ts = wallClockAsUtc - offsetAt(ts);
  return new Date(ts);
}

/**
 * Extract the tenant-local wall-clock components of an instant as
 * zero-padded strings. `hour: '2-digit'` with `hour12: false` renders
 * midnight as '24' in some engines, so we normalize that to '00'.
 */
function tenantWallClockParts(
  d: Date,
  timezone: string,
): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === '24' ? '00' : hour,
    minute: get('minute'),
  };
}

/** The tenant's current calendar day as 'YYYY-MM-DD' in the given IANA tz. */
export function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The 'YYYY-MM-DD' calendar day an instant falls on IN THE TENANT TZ.
 * Derived via `Intl` wall-clock parts (never `toISOString`, which would
 * key off UTC and mis-bucket instants near the tenant's midnight).
 */
export function dateKeyInTz(value: Date | string | number, timezone: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  const { year, month, day } = tenantWallClockParts(d, timezone);
  return `${year}-${month}-${day}`;
}

/**
 * UTC ISO bounds of a tenant-local calendar day. Callers query the
 * half-open interval [startUtc, endUtc): `startUtc` is the tenant's
 * local midnight; `endUtc` is the NEXT local midnight. The next day is
 * computed by calendar arithmetic on Y/M/D (via `Date.UTC(...d+1)`), NOT
 * by adding 24h — a DST spring-forward/fall-back day is 23h/25h long, so
 * "+24h" would land inside or past the wrong day.
 */
export function dayWindowUtc(
  dateKey: string,
  timezone: string,
): { startUtc: string; endUtc: string } {
  const startUtc = tenantWallClockToUtc(dateKey, '00:00', timezone).toISOString();
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const nextDateKey = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  const endUtc = tenantWallClockToUtc(nextDateKey, '00:00', timezone).toISOString();
  return { startUtc, endUtc };
}

/**
 * INVERSE of `tenantWallClockToUtc` for `<input type="datetime-local">`:
 * render a UTC instant as the tenant-local 'YYYY-MM-DDTHH:mm' wall clock.
 * Round-trips to the minute: feeding the split date/time back through
 * `tenantWallClockToUtc(...).toISOString()` returns the original instant.
 */
export function utcToTenantWallClock(value: Date | string | number, timezone: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  const { year, month, day, hour, minute } = tenantWallClockParts(d, timezone);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Convert an `<input type="datetime-local">` value ('YYYY-MM-DDTHH:mm', which
 * carries NO timezone) into the UTC instant it denotes IN THE TENANT TZ — the
 * forward pair of `utcToTenantWallClock`. Splitting on 'T' and delegating to
 * `tenantWallClockToUtc` avoids `new Date(value)`, which interprets the wall
 * clock in the BROWSER's zone and books the slot hours off for a dispatcher
 * whose machine differs from the tenant timezone. Returns an invalid Date for
 * an empty/malformed value (caller guards).
 */
export function datetimeLocalToUtc(value: string, timezone: string): Date {
  if (!value) return new Date(NaN);
  const [date, time = '00:00'] = value.split('T');
  return tenantWallClockToUtc(date, time, timezone);
}

/** Convenience: "Apr 28, 2026, 1:30 PM". */
export function formatDateTimeInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: { locale?: string } = {},
): string {
  return formatInTenantTz(value, timezone, {
    locale: options.locale,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
