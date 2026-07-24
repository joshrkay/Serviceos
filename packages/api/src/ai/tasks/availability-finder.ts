import {
  Appointment,
  AppointmentRepository,
  AppointmentStatus,
  isExpiredHold,
} from '../../appointments/appointment';
import { AssignmentRepository } from '../../appointments/assignment';

/**
 * AvailabilityFinder — read-only "where can I fit a new appointment?"
 * scan over the existing schedule.
 *
 * Companion to `SlotConflictChecker`: the conflict checker is reactive
 * (does the AI's proposed slot collide?), the finder is proactive
 * (what slots are open?). The motivating use case is the inbound voice
 * agent: the caller asks for "Tuesday 2pm", we detect a conflict, and
 * the dispatcher (or, in a follow-up, the AI itself) needs alternative
 * times to offer.
 *
 * v1 keeps the algorithm deliberately simple: scan a caller-supplied
 * window, build the union of busy intervals, return the first N gaps
 * of the requested duration. No business-hours awareness, no per-tech
 * working-hours filter, no preference scoring. Those layer on cleanly
 * later — the dispatcher experience is already useful with three plain
 * "next open" suggestions.
 *
 * Boundary semantics match `SlotConflictChecker.overlaps` — exclusive
 * on both sides. A 10:00-11:00 appointment leaves 11:00 free.
 *
 * Failure-open: any repo error returns `{ ok: false, reason }` so
 * callers can degrade gracefully (no alternatives offered) instead of
 * crashing the larger task.
 *
 * Tenant scoping: tenantId is passed explicitly. The finder never
 * reads request context.
 */

const ACTIVE_APPOINTMENT_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  'scheduled',
  'confirmed',
  'in_progress',
]);

/**
 * Search backward by this much when fetching appointments so we don't
 * miss an appointment that started before searchFrom but ends inside
 * the search window. Mirrors `SlotConflictChecker.SEARCH_BUFFER_MS`.
 */
const SEARCH_BUFFER_MS = 24 * 60 * 60 * 1000;

const DEFAULT_GRANULARITY_MS = 30 * 60 * 1000;
/**
 * Default gap enforced between a candidate slot and any existing
 * appointment, on both sides. Covers travel/setup time so the voice
 * agent never offers two jobs butted back-to-back. A per-tenant
 * override is threaded through in a later plan; callers that pass no
 * `bufferMs` get 0 (unchanged behavior).
 */
export const DEFAULT_BUFFER_MS = 30 * 60 * 1000;
const DEFAULT_SLOT_COUNT = 3;
const MAX_SLOT_COUNT = 10;

export interface OpenSlot {
  start: Date;
  end: Date;
}

export type FindOpenSlotsResult =
  | { ok: true; slots: OpenSlot[] }
  | { ok: false; reason: string };

export interface FindOpenSlotsInput {
  tenantId: string;
  /** Earliest acceptable slot start. */
  searchFrom: Date;
  /** Latest acceptable slot end. Slots that would extend past this are excluded. */
  searchTo: Date;
  /** Required slot length in milliseconds. */
  durationMs: number;
  /**
   * Restrict candidate calculation to the named technician's calendar.
   * When omitted, ANY active appointment in the tenant counts as busy
   * (the safe default for "any-tech" booking).
   */
  technicianId?: string;
  /** Number of open slots to return. Defaults to 3, capped at 10. */
  count?: number;
  /**
   * Snap candidate starts to a grid this wide. Defaults to 30 minutes,
   * which is also typical service-business booking granularity.
   */
  granularityMs?: number;
  /**
   * Gap (ms) to enforce on BOTH sides of every busy interval, so no
   * candidate slot touches an existing appointment. Defaults to 0
   * (no buffer) for backward compatibility.
   */
  bufferMs?: number;
  /**
   * Additional busy intervals from sources other than appointments —
   * technician time-off blocks, holds external to the calendar. Treated
   * as hard-busy but WITHOUT the travel buffer: `bufferMs` models drive
   * time between jobs, which doesn't apply to a PTO boundary.
   */
  extraBusy?: { start: Date; end: Date }[];
}

export interface AvailabilityFinder {
  find(input: FindOpenSlotsInput): Promise<FindOpenSlotsResult>;
}

export interface AvailabilityFinderDeps {
  appointmentRepo: AppointmentRepository;
  /**
   * Required only when callers pass `technicianId`. Without it the
   * finder cannot filter busy intervals down to one tech's calendar
   * and will treat every appointment in the tenant as a blocker —
   * consistent with the SlotConflictChecker fallback.
   */
  assignmentRepo?: AssignmentRepository;
}

/** Snap `t` UP to the next multiple of `granularityMs` from `epoch`. */
function snapUp(t: number, epoch: number, granularityMs: number): number {
  if (t <= epoch) return epoch;
  const delta = t - epoch;
  const rem = delta % granularityMs;
  return rem === 0 ? t : t + (granularityMs - rem);
}

interface BusyInterval {
  start: number;
  end: number;
}

/** Merge overlapping/adjacent intervals so the gap walk is linear. */
function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: BusyInterval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

export class DefaultAvailabilityFinder implements AvailabilityFinder {
  constructor(private readonly deps: AvailabilityFinderDeps) {}

  async find(input: FindOpenSlotsInput): Promise<FindOpenSlotsResult> {
    const granularityMs = input.granularityMs ?? DEFAULT_GRANULARITY_MS;
    const requestedCount = input.count ?? DEFAULT_SLOT_COUNT;
    const count = Math.max(1, Math.min(MAX_SLOT_COUNT, requestedCount));

    if (input.durationMs <= 0) {
      return { ok: false, reason: 'durationMs must be positive' };
    }
    if (granularityMs <= 0) {
      // snapUp() reduces to NaN on a non-positive granularity, which
      // would silently return zero slots OR loop indefinitely depending
      // on which arithmetic happens first. Fail loudly instead.
      return { ok: false, reason: 'granularityMs must be positive' };
    }
    if (input.searchFrom.getTime() >= input.searchTo.getTime()) {
      return { ok: false, reason: 'searchFrom must precede searchTo' };
    }
    if (input.searchTo.getTime() - input.searchFrom.getTime() < input.durationMs) {
      return { ok: true, slots: [] };
    }

    let candidates: Appointment[];
    try {
      const fetchFrom = new Date(input.searchFrom.getTime() - SEARCH_BUFFER_MS);
      candidates = await this.deps.appointmentRepo.findByDateRange(
        input.tenantId,
        fetchFrom,
        input.searchTo,
      );
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    const now = Date.now();
    let blocking = candidates.filter((a) => {
      if (!ACTIVE_APPOINTMENT_STATUSES.has(a.status)) return false;
      // An expired hold has released its slot — treat it as free. A
      // live hold (or a non-hold appointment) still blocks.
      if (isExpiredHold(a, now)) return false;
      return true;
    });

    if (input.technicianId) {
      const techId = input.technicianId;
      const assignmentRepo = this.deps.assignmentRepo;
      if (!assignmentRepo) {
        // Tech filter requested but no assignment repo wired — fail
        // closed: we cannot honor the constraint, so we cannot honestly
        // claim those slots are open for THAT tech.
        return {
          ok: false,
          reason: 'assignmentRepo required when technicianId is provided',
        };
      }
      try {
        // Parallelize the per-appointment assignment lookup. A 36h
        // window in a busy tenant can yield dozens of candidates;
        // sequential awaits multiplied the repo round-trip latency
        // for what is independent work (gemini HIGH on PR #224).
        const assignmentLists = await Promise.all(
          blocking.map((appt) =>
            assignmentRepo.findByAppointment(input.tenantId, appt.id),
          ),
        );
        blocking = blocking.filter((_, i) =>
          assignmentLists[i].some((a) => a.technicianId === techId),
        );
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    const bufferMs = Math.max(0, input.bufferMs ?? 0);
    const busy = mergeIntervals([
      ...blocking.map((a) => ({
        start: a.scheduledStart.getTime() - bufferMs,
        end: a.scheduledEnd.getTime() + bufferMs,
      })),
      ...(input.extraBusy ?? []).map((b) => ({
        start: b.start.getTime(),
        end: b.end.getTime(),
      })),
    ]);

    const windowStart = input.searchFrom.getTime();
    const windowEnd = input.searchTo.getTime();
    const slots: OpenSlot[] = [];

    let cursor = snapUp(windowStart, windowStart, granularityMs);
    for (const interval of busy) {
      if (cursor + input.durationMs <= interval.start) {
        // There is at least one full slot before this busy interval.
        let slotStart = cursor;
        while (
          slotStart + input.durationMs <= interval.start &&
          slots.length < count
        ) {
          slots.push({
            start: new Date(slotStart),
            end: new Date(slotStart + input.durationMs),
          });
          slotStart = snapUp(slotStart + granularityMs, windowStart, granularityMs);
        }
        if (slots.length >= count) return { ok: true, slots };
      }
      cursor = snapUp(Math.max(cursor, interval.end), windowStart, granularityMs);
      if (cursor + input.durationMs > windowEnd) {
        return { ok: true, slots };
      }
    }

    // Fill from after the last busy interval (or from the start when
    // there are no busy intervals) up to windowEnd.
    while (cursor + input.durationMs <= windowEnd && slots.length < count) {
      slots.push({
        start: new Date(cursor),
        end: new Date(cursor + input.durationMs),
      });
      cursor = snapUp(cursor + granularityMs, windowStart, granularityMs);
    }

    return { ok: true, slots };
  }
}
