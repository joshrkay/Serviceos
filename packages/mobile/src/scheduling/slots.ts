/**
 * Slot-picker helpers for the booking screen.
 *
 * The availability endpoint returns open slots as UTC instants
 * (`{ start, end }` ISO). Booking, though, is a wall-clock decision — "Thursday
 * 2 PM" — so these pure helpers render and group those instants in the tenant's
 * timezone (never the device zone) via `Intl`, matching how the read screens
 * render dates. They own the tz-aware formatting so the screen stays a thin
 * consumer, and they're unit-tested with fixed instants + a fixed zone.
 */

export interface Slot {
  start: string;
  end: string;
}

export interface LabeledSlot extends Slot {
  /** Wall-clock start time in the tenant zone, e.g. "2:00 PM". */
  label: string;
}

export interface SlotDay {
  /** `YYYY-MM-DD` in the tenant zone — stable grouping key. */
  dayKey: string;
  /** Human day heading, e.g. "Thu, Jul 23". */
  heading: string;
  slots: LabeledSlot[];
}

/** `YYYY-MM-DD` for an instant in the given zone (the en-CA locale yields ISO). */
export function slotDayKey(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Wall-clock start time in the tenant zone, e.g. "2:00 PM". */
export function formatSlotTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Weekday + short date heading for a day group, e.g. "Thu, Jul 23". */
export function formatDayHeading(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/**
 * Group open slots into tenant-zone days, in chronological order, each slot
 * labeled with its wall-clock start. Invalid instants are skipped. Slot input
 * order is preserved within a day (the endpoint returns them ascending).
 */
export function groupSlotsByDay(slots: Slot[], timeZone?: string): SlotDay[] {
  const byDay = new Map<string, SlotDay>();
  const order: string[] = [];

  for (const slot of slots) {
    const dayKey = slotDayKey(slot.start, timeZone);
    if (!dayKey) continue;
    let day = byDay.get(dayKey);
    if (!day) {
      day = { dayKey, heading: formatDayHeading(slot.start, timeZone), slots: [] };
      byDay.set(dayKey, day);
      order.push(dayKey);
    }
    day.slots.push({ ...slot, label: formatSlotTime(slot.start, timeZone) });
  }

  return order.map((k) => byDay.get(k)!);
}

/** `YYYY-MM-DD` a number of days after a `YYYY-MM-DD` date string (UTC math). */
export function addDaysToDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
