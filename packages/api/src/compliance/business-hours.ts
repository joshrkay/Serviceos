/**
 * Business hours compliance check.
 *
 * Uses IANA timezone and a weekly schedule to determine whether the current
 * moment falls within configured business hours for a tenant.
 *
 * Convention: dayOfWeek follows ISO 8601 — Mon=1 through Sun=7.
 */

export interface BusinessHoursConfig {
  timezone: string; // IANA tz, e.g. "America/Chicago"
  // Mon=1 ... Sun=7
  schedule: Array<{ dayOfWeek: number; openTime: string; closeTime: string }>;
}

export interface BusinessHoursResult {
  isOpen: boolean;
  reason: 'open' | 'after_hours' | 'no_schedule_configured';
}

/**
 * Parse a "HH:MM" time string into fractional minutes-since-midnight.
 * Returns NaN if the string is not valid.
 */
function timeToMinutes(hhmm: string): number {
  const parts = hhmm.split(':');
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

/**
 * Determine whether `now` falls within business hours described by `config`.
 *
 * If config is null or the schedule array is empty, we treat the business as
 * open — fail-open semantics preserve caller availability when misconfigured.
 */
export function checkBusinessHours(
  config: BusinessHoursConfig | null,
  now: Date
): BusinessHoursResult {
  if (!config || config.schedule.length === 0) {
    return { isOpen: true, reason: 'no_schedule_configured' };
  }

  // Determine local date/time in the tenant's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  // Intl.DateTimeFormat weekday gives us "Mon"–"Sun"; map to ISO 1–7
  const parts = formatter.formatToParts(now);
  const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '0';

  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };

  const localDayOfWeek = weekdayMap[weekdayShort];
  if (localDayOfWeek === undefined) {
    // Could not parse — fail open
    return { isOpen: true, reason: 'no_schedule_configured' };
  }

  // hour12:false produces "24" at midnight in some environments; normalise to 0
  const localHour = parseInt(hourPart, 10) % 24;
  const localMinute = parseInt(minutePart, 10);
  const localMinutes = localHour * 60 + localMinute;

  // Find the schedule entry for today
  const todayEntry = config.schedule.find((e) => e.dayOfWeek === localDayOfWeek);
  if (!todayEntry) {
    // No entry for today — business is closed
    return { isOpen: false, reason: 'after_hours' };
  }

  const openMinutes = timeToMinutes(todayEntry.openTime);
  const closeMinutes = timeToMinutes(todayEntry.closeTime);

  if (isNaN(openMinutes) || isNaN(closeMinutes)) {
    // Malformed config — fail open
    return { isOpen: true, reason: 'no_schedule_configured' };
  }

  if (localMinutes >= openMinutes && localMinutes < closeMinutes) {
    return { isOpen: true, reason: 'open' };
  }

  return { isOpen: false, reason: 'after_hours' };
}
