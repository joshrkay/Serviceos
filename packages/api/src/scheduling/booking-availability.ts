import { AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import {
  DefaultAvailabilityFinder,
  OpenSlot,
  DEFAULT_BUFFER_MS,
} from '../ai/tasks/availability-finder';
import { addCalendarDays, isValidTimezone, tzMidnight } from '../shared/timezone';

/**
 * Customer-facing slot search. Wraps the AI `AvailabilityFinder` so the
 * self-service booking portal and the AI booking agent compute open slots
 * with identical logic. The finder itself is business-hours-agnostic; this
 * layer constrains the search to per-day business windows in the tenant's
 * timezone and never offers slots in the past.
 */

export interface BusinessHours {
  /** Local opening hour, 0-23. */
  openHour: number;
  /** Local closing hour, 1-24. */
  closeHour: number;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = { openHour: 8, closeHour: 17 };
const HOUR_MS = 60 * 60 * 1000;
/** Booking cadence — slots are offered on a 30-minute grid from business open. */
const GRANULARITY_MS = 30 * 60 * 1000;
const MAX_RANGE_DAYS = 21;
const MAX_SLOTS = 20;

/** Round `t` up to the next multiple of `granularityMs` measured from `anchor`. */
function snapUpFrom(t: number, anchor: number, granularityMs: number): number {
  if (t <= anchor) return anchor;
  const delta = t - anchor;
  const rem = delta % granularityMs;
  return rem === 0 ? t : t + (granularityMs - rem);
}

export interface BookableSlotsDeps {
  appointmentRepo: AppointmentRepository;
  assignmentRepo?: AssignmentRepository;
}

export interface FindBookableSlotsInput {
  tenantId: string;
  /** Inclusive start day, YYYY-MM-DD. */
  fromDate: string;
  /** Inclusive end day, YYYY-MM-DD. */
  toDate: string;
  /** IANA timezone the business operates in; slots are clamped to its day. */
  timezone: string;
  durationMin: number;
  technicianId?: string;
  businessHours?: BusinessHours;
  maxSlots?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

function buildFinder(deps: BookableSlotsDeps): DefaultAvailabilityFinder {
  return new DefaultAvailabilityFinder({
    appointmentRepo: deps.appointmentRepo,
    assignmentRepo: deps.assignmentRepo,
  });
}

export async function findBookableSlots(
  deps: BookableSlotsDeps,
  input: FindBookableSlotsInput,
): Promise<OpenSlot[]> {
  const tz = isValidTimezone(input.timezone) ? input.timezone : 'UTC';
  const bh = input.businessHours ?? DEFAULT_BUSINESS_HOURS;
  const durationMs = input.durationMin * 60 * 1000;
  if (durationMs <= 0) return [];
  const maxSlots = Math.max(1, Math.min(input.maxSlots ?? 6, MAX_SLOTS));
  const now = input.now ?? new Date();
  const finder = buildFinder(deps);

  // Build the per-day business-hour search windows first (bounded), then query
  // them in parallel — sequential per-day round-trips add avoidable latency.
  const windows: { start: Date; end: Date }[] = [];
  let dayMidnight = tzMidnight(input.fromDate, tz);
  const lastMidnight = tzMidnight(input.toDate, tz);
  let guard = 0;
  while (dayMidnight.getTime() <= lastMidnight.getTime() && guard < MAX_RANGE_DAYS) {
    guard++;
    const winStart = dayMidnight.getTime() + bh.openHour * HOUR_MS;
    const winEnd = dayMidnight.getTime() + bh.closeHour * HOUR_MS;
    // Never offer a slot in the past, and keep the booking cadence clean by
    // snapping a clamped start up to the next grid boundary from business open.
    const effectiveStart =
      winStart < now.getTime() ? snapUpFrom(now.getTime(), winStart, GRANULARITY_MS) : winStart;
    if (effectiveStart + durationMs <= winEnd) {
      windows.push({ start: new Date(effectiveStart), end: new Date(winEnd) });
    }
    dayMidnight = addCalendarDays(dayMidnight, 1, tz);
  }

  const perWindow = await Promise.all(
    windows.map((w) =>
      finder.find({
        tenantId: input.tenantId,
        searchFrom: w.start,
        searchTo: w.end,
        durationMs,
        technicianId: input.technicianId,
        count: maxSlots,
        granularityMs: GRANULARITY_MS,
        bufferMs: DEFAULT_BUFFER_MS,
      }),
    ),
  );

  // Windows are already in chronological order; flatten and cap.
  const slots: OpenSlot[] = [];
  for (const result of perWindow) {
    if (result.ok) slots.push(...result.slots);
    if (slots.length >= maxSlots) break;
  }
  return slots.slice(0, maxSlots);
}

/**
 * Re-verify a specific slot is still open at book time. Guards against two
 * customers grabbing the same window between availability fetch and booking:
 * the first booking's hold makes the finder report the slot busy, so the
 * second `isSlotFree` returns false. Uses a zero buffer because we are
 * checking the literal slot the customer was already offered.
 */
export async function isSlotFree(
  deps: BookableSlotsDeps,
  input: { tenantId: string; start: Date; end: Date; technicianId?: string },
): Promise<boolean> {
  const durationMs = input.end.getTime() - input.start.getTime();
  if (durationMs <= 0) return false;
  const finder = buildFinder(deps);
  const result = await finder.find({
    tenantId: input.tenantId,
    searchFrom: input.start,
    searchTo: input.end,
    durationMs,
    technicianId: input.technicianId,
    count: 1,
    bufferMs: 0,
  });
  return result.ok && result.slots.length > 0 && result.slots[0].start.getTime() === input.start.getTime();
}
