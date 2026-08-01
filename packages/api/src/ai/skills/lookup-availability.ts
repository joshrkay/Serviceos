import type {
  AvailabilityFinder,
  OpenSlot,
} from '../tasks/availability-finder';
import {
  findBookableSlots,
  BookableSlotsDeps,
  WeeklyBusinessHours,
} from '../../scheduling/booking-availability';

/**
 * lookup-availability — skill the calling agent (and the dispatcher
 * surface, in the meantime) uses to obtain "next N open slots" plus a
 * caller-friendly TTS summary.
 *
 * v1 keeps the wrapper deterministic on top of `AvailabilityFinder`:
 * no LLM call, no scoring beyond "earliest first." When the finder
 * fails, we surface `status: 'unavailable'` so the caller (FSM
 * adapter or task handler) can fall back to the existing
 * voice_clarification path without alternatives.
 */

export interface LookupAvailabilityInput {
  tenantId: string;
  searchFrom: Date;
  searchTo: Date;
  durationMs: number;
  technicianId?: string;
  count?: number;
  /** Gap (ms) to enforce around existing appointments. Forwarded to the finder. */
  bufferMs?: number;
  /**
   * IANA timezone for rendering the spoken summary (e.g.
   * "America/Los_Angeles"). When omitted the summary uses the runtime
   * default — fine for tests, not fine for production.
   */
  timezone?: string;
}

export type LookupAvailabilityResult =
  | {
      status: 'ok';
      slots: OpenSlot[];
      /** Caller-facing TTS line, e.g. "I have 1 PM or 3 PM on Tuesday — which works?" */
      message: string;
    }
  | { status: 'no_slots'; message: string }
  | { status: 'unavailable'; reason: string };

/**
 * Render a slot as "Tuesday at 1 PM" using the supplied formatters.
 * Formatters are passed in so `describeSlots` can construct them once
 * and reuse across all slots.
 */
function describeSlot(
  slot: OpenSlot,
  weekdayFormatter: Intl.DateTimeFormat,
  timeFormatter: Intl.DateTimeFormat,
): string {
  const weekday = weekdayFormatter.format(slot.start);
  const time = timeFormatter.format(slot.start);
  // Drop ":00" so "1:00 PM" reads as "1 PM" — sounds more natural in TTS.
  return `${weekday} at ${time.replace(':00', '')}`;
}

/**
 * Render up to N slots as a single English clause:
 *   1 → "Tuesday at 1 PM"
 *   2 → "Tuesday at 1 PM or Tuesday at 3 PM"
 *   3+ → "Tuesday at 1 PM, Tuesday at 3 PM, or Wednesday at 9 AM"
 *
 * Exported so the FSM adapter (in a follow-up) can reuse the same
 * phrasing without reaching into the skill internals.
 */
export function describeSlots(slots: OpenSlot[], timezone?: string): string {
  if (slots.length === 0) return '';

  // `Intl.DateTimeFormat` accepts undefined timezone (uses runtime
  // default). Construct once per call so we don't pay the formatter
  // setup cost per-slot.
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: timezone,
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
    timeZone: timezone,
  });

  const labels = slots.map((s) => describeSlot(s, weekdayFormatter, timeFormatter));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  const head = labels.slice(0, -1).join(', ');
  return `${head}, or ${labels[labels.length - 1]}`;
}

/** Shared phrasing for both lookup variants — one-vs-many lead-in so the TTS doesn't sound robotic. */
function slotsToResult(slots: OpenSlot[], timezone?: string): LookupAvailabilityResult {
  if (slots.length === 0) {
    return {
      status: 'no_slots',
      message: "I'm not seeing any open slots in that range — let me get a person to help.",
    };
  }
  const summary = describeSlots(slots, timezone);
  const message =
    slots.length === 1
      ? `I have ${summary} open — does that work?`
      : `I have ${summary} open — which works for you?`;
  return { status: 'ok', slots, message };
}

export async function lookupAvailability(
  input: LookupAvailabilityInput,
  finder: AvailabilityFinder,
): Promise<LookupAvailabilityResult> {
  const result = await finder.find({
    tenantId: input.tenantId,
    searchFrom: input.searchFrom,
    searchTo: input.searchTo,
    durationMs: input.durationMs,
    technicianId: input.technicianId,
    count: input.count,
    bufferMs: input.bufferMs,
  });

  if (!result.ok) {
    return { status: 'unavailable', reason: result.reason };
  }

  return slotsToResult(result.slots, input.timezone);
}

export interface LookupBookableAvailabilityInput {
  tenantId: string;
  /** Tenant IANA timezone — windows are defined in it and the summary renders in it. */
  timezone: string;
  searchFrom: Date;
  /** Horizon in calendar days from `searchFrom`. */
  searchDays: number;
  durationMs: number;
  technicianId?: string;
  count?: number;
  /** Tenant per-day hours (`tenant_settings.business_hours`). */
  weeklyHours?: WeeklyBusinessHours | null;
  /** Tenant travel buffer (`tenant_settings.job_buffer_minutes`). */
  bufferMinutes?: number | null;
}

/**
 * Business-hours-aware variant for voice surfaces. The raw-finder variant
 * above walks calendar gaps with no notion of business hours, working hours,
 * time-off, or the travel buffer — fine for a dispatcher told "the calendar
 * is open", wrong for an inbound caller who would be offered 3 AM. This one
 * routes through `findBookableSlots`, the same intersection every booking
 * surface uses, so the agent only speaks slots the tenant could actually
 * honor (F2 in spec/RIVET_FOUNDATION_SPEC.md).
 */
export async function lookupBookableAvailability(
  input: LookupBookableAvailabilityInput,
  deps: BookableSlotsDeps,
): Promise<LookupAvailabilityResult> {
  const ymdInTz = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: input.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  try {
    const fromDate = ymdInTz(input.searchFrom);
    const toDate = ymdInTz(
      new Date(input.searchFrom.getTime() + input.searchDays * 24 * 60 * 60 * 1000),
    );
    const slots = await findBookableSlots(deps, {
      tenantId: input.tenantId,
      fromDate,
      toDate,
      timezone: input.timezone,
      durationMin: Math.round(input.durationMs / 60000),
      technicianId: input.technicianId,
      weeklyHours: input.weeklyHours,
      bufferMinutes: input.bufferMinutes,
      maxSlots: input.count ?? 3,
      now: input.searchFrom,
    });
    return slotsToResult(slots, input.timezone);
  } catch (err) {
    // Same failure-open contract as the raw finder: callers degrade to the
    // clarification path instead of crashing the call.
    return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}
