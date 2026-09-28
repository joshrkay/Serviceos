/**
 * WS18 — shared tentative-appointment-hold placement.
 *
 * Extracted verbatim from `CreateAppointmentAITaskHandler` (the recorded-voice
 * path) so the LIVE call close flow (media-streams turn) can place the exact
 * same catalog-safe 24h hold before an autonomous D-018 close. The D-015 lane
 * requires `holdPlaced`; this is the single seam that places it.
 *
 * Two entry points:
 *   - `placeAppointmentHold` — takes ALREADY-RESOLVED timestamps (the task path
 *     resolves once, up front, for its non-held branches too).
 *   - `resolveAndPlaceAppointmentHold` — takes the raw spoken date/time phrase +
 *     tenant tz + now, runs `resolveDateTime` internally, and returns the
 *     resolved window alongside the hold so the caller can speak the booked
 *     time. Unresolvable / ambiguous / past → `{ failed: 'unresolved_datetime' }`.
 *
 * The ownership guard (jobId belongs to the verified caller) and the
 * createAppointment write are byte-for-byte the task's, so its existing tests
 * pin the shared behavior.
 */
import {
  Appointment,
  AppointmentRepository,
  createAppointment,
} from '../../appointments/appointment';
import { checkFeasibility } from '../../scheduling/feasibility';
import type {
  FeasibilityDependencies,
  FeasibilityIssue,
} from '../../scheduling/feasibility-types';
import { JobRepository } from '../../jobs/job';
import {
  resolveDateTime,
} from './resolve-datetime';
import { isRuntimeTimezone } from '../../shared/timezone';
import type { AppointmentTypeValue } from '@ai-service-os/shared';

/** Default tentative-hold window — a 24h approval window (matches the task). */
export const DEFAULT_HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlaceHoldFailure =
  | 'unresolved_datetime'
  /**
   * The TENANT has no usable IANA timezone, so a spoken phrase cannot be
   * turned into an instant. Distinct from `unresolved_datetime`, where the
   * phrase itself was the problem — here the caller said something perfectly
   * clear and the business is misconfigured.
   */
  | 'timezone_unconfigured'
  | 'job_not_owned'
  | 'hold_write_failed';

/**
 * #1045 / PRD 3.12 — the back-to-back drivability check on the hold path.
 * `checked: false` means the check did NOT run (no feasibility deps wired, or
 * it threw) — never read that as an all-clear. Warnings are advisory: a hold
 * is still placed; the operator sees them on the booking proposal.
 */
export interface HoldFeasibility {
  checked: boolean;
  /** Warning-severity issues, each stamped with `metadata.technicianId`. */
  warnings: FeasibilityIssue[];
}

export type PlaceHoldResult =
  | { ok: true; appointmentId: string; holdExpiryAt: Date; feasibility: HoldFeasibility }
  | { ok: false; failed: PlaceHoldFailure };

export interface PlaceHoldDeps {
  appointmentRepo: AppointmentRepository;
  /**
   * When wired, the jobId is verified to belong to the identified caller before
   * a real (held) row is written — an injected/guessed id can't pollute another
   * customer's calendar. No jobRepo → cannot verify → the legacy held path
   * (unchanged): the write proceeds.
   */
  jobRepo?: JobRepository;
  /**
   * #1045 — when wired, the placed hold is run through `checkFeasibility`
   * (the same composer POST /check-feasibility and the reschedule/reassign
   * handlers use) so a back-to-back slot that is not drivable surfaces a
   * `travel_time` warning on the hold instead of being promised blind.
   */
  feasibility?: FeasibilityDependencies;
}

export interface PlaceHoldArgs {
  tenantId: string;
  /** LLM-extracted; verified against the caller when a jobRepo is wired. */
  jobId: string;
  /** Verified caller id (caller-ID match / resolver). */
  customerId?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  /** Display/context timezone; the time fields persist as UTC instants. */
  timezone: string;
  arrival?: { startUtc: string; endUtc: string };
  notes?: string;
  appointmentType?: AppointmentTypeValue;
  createdBy: string;
  /** Overrides the hold-window base instant (defaults to now). */
  now?: Date;
  holdWindowMs?: number;
  /** Deterministic dedup key so a redelivery returns the existing hold. */
  idempotencyKey?: string;
}

/**
 * Place a tentative hold from already-resolved timestamps. Ownership guard +
 * createAppointment(holdPendingApproval). Never throws — a repo/validation
 * failure resolves to `{ failed: 'hold_write_failed' }`.
 */
export async function placeAppointmentHold(
  deps: PlaceHoldDeps,
  args: PlaceHoldArgs,
): Promise<PlaceHoldResult> {
  // Ownership guard: only when we CAN verify (jobRepo wired) do we require a
  // well-formed UUID that resolves to a job the verified caller owns.
  if (deps.jobRepo) {
    if (!UUID_RE.test(args.jobId) || !args.customerId) {
      return { ok: false, failed: 'job_not_owned' };
    }
    const ownedJob = await deps.jobRepo
      .findById(args.tenantId, args.jobId)
      .catch(() => null);
    if (!ownedJob || ownedJob.customerId !== args.customerId) {
      return { ok: false, failed: 'job_not_owned' };
    }
  }

  const base = args.now?.getTime() ?? Date.now();
  const holdExpiryAt = new Date(base + (args.holdWindowMs ?? DEFAULT_HOLD_WINDOW_MS));
  try {
    const held = await createAppointment(
      {
        tenantId: args.tenantId,
        jobId: args.jobId,
        scheduledStart: args.scheduledStart,
        scheduledEnd: args.scheduledEnd,
        timezone: args.timezone,
        ...(args.arrival
          ? {
              arrivalWindowStart: new Date(args.arrival.startUtc),
              arrivalWindowEnd: new Date(args.arrival.endUtc),
            }
          : {}),
        ...(args.notes ? { notes: args.notes } : {}),
        ...(args.appointmentType ? { appointmentType: args.appointmentType } : {}),
        createdBy: args.createdBy,
        holdPendingApproval: true,
        holdExpiryAt,
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      },
      deps.appointmentRepo,
    );
    const feasibility = await checkHoldFeasibility(deps.feasibility, args.tenantId, held);
    return { ok: true, appointmentId: held.id, holdExpiryAt, feasibility };
  } catch {
    return { ok: false, failed: 'hold_write_failed' };
  }
}

/** Mirrors feasibility.ts's neighbour window: a day either side of the slot. */
const NEIGHBOUR_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A voice hold is placed before anyone is dispatched, so there is no single
 * technician to check. The candidates are the technicians whose calendars
 * neighbour the slot (assigned to a live appointment within a day of it) —
 * the only calendars a back-to-back drive can be infeasible on. Each one is
 * run through `checkFeasibility`; their warning-severity issues are returned
 * stamped with the technician so the operator knows whose day it breaks.
 * Never throws: a failure degrades to `checked: false`.
 */
async function checkHoldFeasibility(
  deps: FeasibilityDependencies | undefined,
  tenantId: string,
  held: Appointment,
): Promise<HoldFeasibility> {
  return checkSlotFeasibility(deps, tenantId, held);
}

/**
 * The neighbour-technician drivability check behind both booking-creation
 * paths (PRD 3.12): a placed hold (above) and a not-yet-written
 * `create_appointment` candidate, which has no job yet and so names the
 * service location to drive to (`targetLocationId`). Same contract: the
 * warning-severity issues, each stamped with the technician; `checked: false`
 * when not wired or on failure — never a silent all-clear.
 */
export async function checkSlotFeasibility(
  deps: FeasibilityDependencies | undefined,
  tenantId: string,
  held: Appointment,
  opts: { targetLocationId?: string } = {},
): Promise<HoldFeasibility> {
  if (!deps) return { checked: false, warnings: [] };
  try {
    const neighbours = await deps.appointmentRepo.findByDateRange(
      tenantId,
      new Date(held.scheduledStart.getTime() - NEIGHBOUR_WINDOW_MS),
      new Date(held.scheduledEnd.getTime() + NEIGHBOUR_WINDOW_MS),
    );
    const technicianIds = new Set<string>();
    for (const appt of neighbours) {
      if (appt.id === held.id || appt.status === 'canceled') continue;
      const assignments = await deps.assignmentRepo.findByAppointment(tenantId, appt.id);
      for (const a of assignments) technicianIds.add(a.technicianId);
    }
    const warnings: FeasibilityIssue[] = [];
    for (const technicianId of technicianIds) {
      const result = await checkFeasibility(
        {
          tenantId,
          appointment: held,
          proposedTechnicianId: technicianId,
          proposedScheduledStart: held.scheduledStart,
          proposedScheduledEnd: held.scheduledEnd,
          ...(opts.targetLocationId ? { targetLocationId: opts.targetLocationId } : {}),
        },
        deps,
      );
      for (const w of result.warnings) {
        warnings.push({ ...w, metadata: { ...(w.metadata ?? {}), technicianId } });
      }
    }
    return { checked: true, warnings };
  } catch {
    return { checked: false, warnings: [] };
  }
}

export interface ResolveAndPlaceHoldArgs {
  tenantId: string;
  jobId: string;
  customerId?: string;
  /** The date/time phrase EXACTLY as spoken ("next Tuesday at 2pm"). */
  dateTimeDescription: string;
  timezone?: string;
  now?: Date;
  defaultDurationMin?: number;
  notes?: string;
  appointmentType?: AppointmentTypeValue;
  createdBy: string;
  holdWindowMs?: number;
  idempotencyKey?: string;
}

/**
 * Resolve a spoken date/time phrase and place a hold on the resolved window.
 * The live-call close flow uses this so it can both place the D-015-required
 * hold AND speak the booked time. On success the resolved window rides back so
 * the caller need not resolve twice.
 */
export async function resolveAndPlaceAppointmentHold(
  deps: PlaceHoldDeps,
  args: ResolveAndPlaceHoldArgs,
): Promise<
  | { ok: true; appointmentId: string; holdExpiryAt: Date; feasibility: HoldFeasibility; scheduledStart: string; scheduledEnd: string; timezone: string; arrival?: { startUtc: string; endUtc: string } }
  | { ok: false; failed: PlaceHoldFailure }
> {
  // NO DEFAULT ZONE. This is the autonomous live-call close: it writes a real
  // held appointment AND speaks the time back to the caller. Falling through
  // to America/New_York here is the same defect that put an America/Phoenix
  // operator's bookings three hours off — except on this path the wrong time
  // is also read aloud to the customer as confirmation. Refusing routes the
  // turn to the caller's existing `scheduling_incomplete` fallback, which
  // does not book and does not claim a time.
  const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : '';
  if (!timezone || !isRuntimeTimezone(timezone)) {
    return { ok: false, failed: 'timezone_unconfigured' };
  }
  const now = args.now ?? new Date();
  const resolved = resolveDateTime(args.dateTimeDescription, {
    timezone,
    now,
    ...(args.defaultDurationMin ? { defaultDurationMin: args.defaultDurationMin } : {}),
  });
  if (!resolved.ok) return { ok: false, failed: 'unresolved_datetime' };

  const arrival =
    resolved.arrivalWindowStartUtc && resolved.arrivalWindowEndUtc
      ? { startUtc: resolved.arrivalWindowStartUtc, endUtc: resolved.arrivalWindowEndUtc }
      : undefined;

  const held = await placeAppointmentHold(deps, {
    tenantId: args.tenantId,
    jobId: args.jobId,
    ...(args.customerId ? { customerId: args.customerId } : {}),
    scheduledStart: new Date(resolved.startUtc),
    scheduledEnd: new Date(resolved.endUtc),
    timezone: resolved.timezone,
    ...(arrival ? { arrival } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
    ...(args.appointmentType ? { appointmentType: args.appointmentType } : {}),
    createdBy: args.createdBy,
    now,
    ...(args.holdWindowMs ? { holdWindowMs: args.holdWindowMs } : {}),
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
  });
  if (!held.ok) return held;
  return {
    ok: true,
    appointmentId: held.appointmentId,
    holdExpiryAt: held.holdExpiryAt,
    feasibility: held.feasibility,
    scheduledStart: resolved.startUtc,
    scheduledEnd: resolved.endUtc,
    timezone: resolved.timezone,
    ...(arrival ? { arrival } : {}),
  };
}
