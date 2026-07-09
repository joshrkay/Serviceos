/**
 * New-job flow → dispatch board glue (Issue 2).
 *
 * The new-job schedule step captures a date chip + a time chip. This resolves
 * that pair into a concrete instant range to POST to `/api/jobs/:id/schedule`,
 * or returns null when the selection isn't concretely schedulable — no time
 * picked, or a demo/placeholder date label ("Tue Mar 11", "Custom") that has no
 * real calendar date. Null ⇒ create the job unscheduled (prior behavior).
 *
 * The picked wall-clock date+time is interpreted in the TENANT timezone and
 * serialized to a UTC ISO instant (via tenantWallClockToUtc), matching how
 * SchedulePage builds the appointments it POSTs.
 */
import { tenantWallClockToUtc } from '../../utils/formatInTenantTz';

const DEFAULT_DURATION_MIN = 60;

export interface ScheduleSlot {
  scheduledStart: string;
  scheduledEnd: string;
}

/** Today's calendar date in the given timezone, as [y, month(1-12), day], or null. */
function tenantYmdParts(now: Date, timezone: string): [number, number, number] | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
    const [y, mo, d] = [get('year'), get('month'), get('day')];
    return [y, mo, d].some(Number.isNaN) ? null : [y, mo, d];
  } catch {
    return null;
  }
}

/** `now` + `offset` days, evaluated in the TENANT timezone, as ISO `YYYY-MM-DD`. */
export function tenantDateIso(offset: number, timezone: string, now: Date = new Date()): string {
  const [y, mo, d] =
    tenantYmdParts(now, timezone) ?? [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  // Date.UTC normalizes month/year rollover; read back the pure calendar date.
  return new Date(Date.UTC(y, mo - 1, d + offset)).toISOString().slice(0, 10);
}

/**
 * Nearest upcoming date for a weekday (today counts), as ISO `YYYY-MM-DD`,
 * evaluated from the TENANT calendar day. Lets voice-parsed weekdays ("Friday
 * at 10am") resolve to a real appointment the same way the date chips do,
 * rather than a placeholder label that silently drops the schedule — and, like
 * Today/Tomorrow, anchored to the tenant's day so a dispatcher in another zone
 * doesn't land on the wrong week. Weekday index is JS-native: Sun=0 … Sat=6.
 */
export function nextWeekdayIso(targetDow: number, timezone: string, from: Date = new Date()): string {
  const [y, mo, d] =
    tenantYmdParts(from, timezone) ?? [from.getFullYear(), from.getMonth() + 1, from.getDate()];
  const baseDow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return tenantDateIso((targetDow - baseDow + 7) % 7, timezone, from);
}

/**
 * Resolve a date chip value to a `YYYY-MM-DD` date, or null.
 *
 * Today/Tomorrow are resolved from the calendar day in the TENANT timezone (not
 * the dispatcher's browser day): a Pacific dispatcher after 9 PM booking an
 * Eastern tenant means the tenant is already "tomorrow", so "Today" must be the
 * tenant's date — otherwise the appointment lands on the wrong (past) board day.
 */
function resolveYmd(scheduledDate: string, now: Date, timezone: string): string | null {
  const value = scheduledDate.trim();
  if (!value) return null;
  // A real date input (`type=date`) yields an ISO calendar date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^today$/i.test(value)) return tenantDateIso(0, timezone, now);
  if (/^tomorrow$/i.test(value)) return tenantDateIso(1, timezone, now);
  // Placeholder/demo labels ("Tue Mar 11", "Custom", "__custom") aren't
  // concretely schedulable.
  return null;
}

/** Parse a "h:mm AM/PM" time chip into 24h "HH:MM", or null. */
function resolveHm(scheduledTime: string): string | null {
  const m = scheduledTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const isPm = m[3].toUpperCase() === 'PM';
  if (hour === 12) hour = isPm ? 12 : 0;
  else if (isPm) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function resolveScheduleSlot(
  scheduledDate: string,
  scheduledTime: string,
  timezone: string,
  now: Date = new Date(),
  durationMin: number = DEFAULT_DURATION_MIN,
): ScheduleSlot | null {
  const ymd = resolveYmd(scheduledDate, now, timezone);
  if (!ymd) return null;
  const hm = resolveHm(scheduledTime);
  if (!hm) return null;

  // Interpret the wall-clock date+time in the TENANT timezone, not the
  // dispatcher's browser tz — so a Pacific dispatcher scheduling a New York
  // tenant for 2 PM stores 2 PM ET, and the board/tech views render it at 2 PM.
  const start = tenantWallClockToUtc(ymd, hm, timezone);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}
