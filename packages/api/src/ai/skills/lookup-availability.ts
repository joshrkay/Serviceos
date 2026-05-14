import type {
  AvailabilityFinder,
  OpenSlot,
} from '../tasks/availability-finder';

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

  if (result.slots.length === 0) {
    return {
      status: 'no_slots',
      message: "I'm not seeing any open slots in that range — let me get a person to help.",
    };
  }

  // Use a different lead-in for one-vs-many so the TTS doesn't sound
  // robotic.
  const summary = describeSlots(result.slots, input.timezone);
  const message =
    result.slots.length === 1
      ? `I have ${summary} open — does that work?`
      : `I have ${summary} open — which works for you?`;

  return { status: 'ok', slots: result.slots, message };
}
