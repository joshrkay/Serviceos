/**
 * Pure (RN-free) helpers for the SlotPicker: grouping open slots by their
 * tenant-local day and formatting day headers + time ranges. Times are stored
 * UTC and rendered in the tenant timezone (same discipline as technicianDay.ts)
 * — a slot at 2026-06-22T02:00:00Z is "Jun 21" in America/New_York, not Jun 22.
 * Kept pure so the tz math unit-tests without a renderer.
 */

export interface Slot {
  start: string;
  end: string;
}

export interface SlotDayGroup {
  /** Tenant-local YYYY-MM-DD key, so slots bucket by the day the operator sees. */
  dayKey: string;
  /** Human day header, e.g. "Mon, Jun 22". */
  dayLabel: string;
  slots: Slot[];
}

/** Add `days` calendar days to a YYYY-MM-DD string (UTC math, tz-agnostic). */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Tenant-local YYYY-MM-DD for an instant (falls back to runtime local tz). */
export function slotDayKey(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // en-CA renders ISO-style YYYY-MM-DD, so string compare == chronological.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Human day header for a slot group, e.g. "Mon, Jun 22". */
export function formatSlotDayLabel(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Time-of-day range for a slot in tenant tz, e.g. "8:00 AM – 9:00 AM". */
export function formatSlotTimeRange(slot: Slot, timeZone?: string): string {
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * Group slots into tenant-local days, preserving chronological order (the
 * server already returns slots ascending; a stable string sort on the day key
 * keeps days ordered too).
 */
export function groupSlotsByDay(slots: Slot[], timeZone?: string): SlotDayGroup[] {
  const groups = new Map<string, SlotDayGroup>();
  const order: string[] = [];
  for (const slot of slots) {
    const dayKey = slotDayKey(slot.start, timeZone);
    if (!dayKey) continue;
    let group = groups.get(dayKey);
    if (!group) {
      group = { dayKey, dayLabel: formatSlotDayLabel(slot.start, timeZone), slots: [] };
      groups.set(dayKey, group);
      order.push(dayKey);
    }
    group.slots.push(slot);
  }
  return order.map((k) => groups.get(k)!);
}
