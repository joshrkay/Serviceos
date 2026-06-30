/**
 * New-job flow → dispatch board glue (Issue 2).
 *
 * The new-job schedule step captures a date chip + a time chip. This resolves
 * that pair into a concrete instant range to POST to `/api/jobs/:id/schedule`,
 * or returns null when the selection isn't concretely schedulable — no time
 * picked, or a demo/placeholder date label ("Tue Mar 11", "Custom") that has no
 * real calendar date. Null ⇒ create the job unscheduled (prior behavior).
 *
 * The date is interpreted in browser-local time and serialized to a UTC ISO
 * instant, matching how SchedulePage builds the appointments it already POSTs.
 */

const DEFAULT_DURATION_MIN = 60;

export interface ScheduleSlot {
  scheduledStart: string;
  scheduledEnd: string;
}

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Resolve a date chip value to a `YYYY-MM-DD` local date, or null. */
function resolveYmd(scheduledDate: string, now: Date): string | null {
  const value = scheduledDate.trim();
  if (!value) return null;
  if (/^today$/i.test(value)) return toYmd(now);
  if (/^tomorrow$/i.test(value)) {
    return toYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  }
  // A real date input (`type=date`) yields an ISO calendar date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
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
  now: Date = new Date(),
  durationMin: number = DEFAULT_DURATION_MIN,
): ScheduleSlot | null {
  const ymd = resolveYmd(scheduledDate, now);
  if (!ymd) return null;
  const hm = resolveHm(scheduledTime);
  if (!hm) return null;

  const start = new Date(`${ymd}T${hm}:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}
