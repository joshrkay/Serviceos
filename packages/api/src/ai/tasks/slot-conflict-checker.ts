import { Appointment, AppointmentRepository } from '../../appointments/appointment';
import { AssignmentRepository } from '../../appointments/assignment';
import { JobRepository } from '../../jobs/job';

/**
 * SlotConflictChecker — pre-draft availability check for AI-drafted
 * `create_appointment` proposals.
 *
 * Today the AI task router for `create_appointment` proposals goes
 * straight from intent → proposal without checking whether the slot
 * is actually available. This produces conflicting proposals that
 * waste dispatcher review time and erode trust in the AI.
 *
 * The checker is invoked from `create-appointment-task.ts` BEFORE
 * the proposal is built. On a conflict the task surfaces a
 * `voice_clarification` proposal asking the operator to pick another
 * time / technician, with the conflicting appointment id attached
 * for context.
 *
 * Boundary semantics: we use STRICT overlap, i.e. two windows
 * conflict iff `start_a < end_b AND end_a > start_b`. A 10:00-11:00
 * appointment does NOT conflict with an 11:00-12:00 appointment —
 * exclusive boundaries on both sides. This matches dispatcher
 * intuition (an appointment "ends at 11" means the tech is free at 11).
 *
 * Failure-open: if the underlying repo throws, we surface a
 * `could_not_verify` result rather than crashing the task. The task
 * then produces a `voice_clarification` saying "I couldn't verify
 * the slot — please confirm." Preserves user intent when the DB is
 * flaky; the operator still has the manual review gate before any
 * appointment is actually created.
 *
 * Tenant scoping: the checker runs inside the AI task pipeline,
 * which already has the tenant id in scope. It is passed explicitly
 * to `check()`; we never attempt to read it from request context.
 */

export type SlotConflictResult =
  | { ok: true }
  | {
      ok: false;
      conflict: 'technician_busy' | 'customer_busy';
      appointmentId: string;
      conflictWindow: { start: Date; end: Date };
    }
  | { ok: false; conflict: 'could_not_verify'; reason: string };

export interface SlotConflictCheckerInput {
  tenantId: string;
  windowStart: Date;
  windowEnd: Date;
  /** Undefined / 'unassigned' means the proposed appointment has no tech yet. */
  technicianId?: string;
  customerId: string;
}

export interface SlotConflictChecker {
  check(input: SlotConflictCheckerInput): Promise<SlotConflictResult>;
}

export interface SlotConflictCheckerDeps {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo: JobRepository;
}

/**
 * Strict-overlap test. A appointment [a.start, a.end) conflicts with
 * the proposed window [w.start, w.end) iff
 *     a.start < w.end  AND  a.end > w.start
 * Boundary case: a 10:00-11:00 appointment vs an 11:00-12:00 window
 * yields a.end (11:00) > w.start (11:00) → false → no conflict.
 */
export function overlaps(
  a: { start: Date; end: Date },
  w: { start: Date; end: Date }
): boolean {
  return a.start.getTime() < w.end.getTime() && a.end.getTime() > w.start.getTime();
}

/**
 * `findByDateRange` filters by `scheduled_start` only, so it would
 * miss an appointment that started before the window but ends inside
 * it. Expand the lookup range backward by an hour-sized buffer to
 * catch realistic pre-existing appointments without hammering the
 * DB. 24h is more than enough for a service-business workday.
 */
const SEARCH_BUFFER_MS = 24 * 60 * 60 * 1000;

export class DefaultSlotConflictChecker implements SlotConflictChecker {
  constructor(private readonly deps: SlotConflictCheckerDeps) {}

  async check(input: SlotConflictCheckerInput): Promise<SlotConflictResult> {
    const { tenantId, windowStart, windowEnd, technicianId, customerId } = input;

    let candidates: Appointment[];
    try {
      const searchFrom = new Date(windowStart.getTime() - SEARCH_BUFFER_MS);
      // Use `windowEnd` as the upper bound. `findByDateRange` filters
      // by `scheduledStart` so any appointment whose start is at or
      // after windowEnd is excluded — correct, since such an appt
      // can't possibly overlap [windowStart, windowEnd).
      candidates = await this.deps.appointmentRepo.findByDateRange(
        tenantId,
        searchFrom,
        windowEnd
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, conflict: 'could_not_verify', reason: message };
    }

    // Filter to true overlaps (the repo returns "starts within range",
    // not strict overlap — we still apply the strict-overlap predicate).
    const overlapping = candidates.filter((a) =>
      overlaps(
        { start: a.scheduledStart, end: a.scheduledEnd },
        { start: windowStart, end: windowEnd }
      )
    );

    if (overlapping.length === 0) return { ok: true };

    // Tech-busy check FIRST. If both the tech and the customer are
    // busy, surface the technician conflict — that's more actionable
    // for the dispatcher (they can reassign the tech, but rarely the
    // customer). Skip entirely when no technician was proposed
    // ("unassigned" slot).
    if (technicianId) {
      try {
        for (const appt of overlapping) {
          const assignments = await this.deps.assignmentRepo.findByAppointment(
            tenantId,
            appt.id
          );
          if (assignments.some((a) => a.technicianId === technicianId)) {
            return {
              ok: false,
              conflict: 'technician_busy',
              appointmentId: appt.id,
              conflictWindow: { start: appt.scheduledStart, end: appt.scheduledEnd },
            };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, conflict: 'could_not_verify', reason: message };
      }
    }

    // Customer-busy check. Resolve each overlapping appointment's job
    // to find its customer; if any matches the proposed customer, the
    // customer is double-booked.
    try {
      for (const appt of overlapping) {
        const job = await this.deps.jobRepo.findById(tenantId, appt.jobId);
        if (job && job.customerId === customerId) {
          return {
            ok: false,
            conflict: 'customer_busy',
            appointmentId: appt.id,
            conflictWindow: { start: appt.scheduledStart, end: appt.scheduledEnd },
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, conflict: 'could_not_verify', reason: message };
    }

    // There ARE overlapping appointments, but none of them involve
    // this technician or this customer — no actual conflict.
    return { ok: true };
  }
}
