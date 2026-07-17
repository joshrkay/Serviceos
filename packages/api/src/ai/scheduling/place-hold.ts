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
  AppointmentRepository,
  createAppointment,
} from '../../appointments/appointment';
import { JobRepository } from '../../jobs/job';
import {
  resolveDateTime,
  DEFAULT_TENANT_TIMEZONE,
} from './resolve-datetime';
import type { AppointmentTypeValue } from '@ai-service-os/shared';

/** Default tentative-hold window — a 24h approval window (matches the task). */
export const DEFAULT_HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlaceHoldFailure =
  | 'unresolved_datetime'
  | 'job_not_owned'
  | 'hold_write_failed';

export type PlaceHoldResult =
  | { ok: true; appointmentId: string; holdExpiryAt: Date }
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
    return { ok: true, appointmentId: held.id, holdExpiryAt };
  } catch {
    return { ok: false, failed: 'hold_write_failed' };
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
  | { ok: true; appointmentId: string; holdExpiryAt: Date; scheduledStart: string; scheduledEnd: string; timezone: string; arrival?: { startUtc: string; endUtc: string } }
  | { ok: false; failed: PlaceHoldFailure }
> {
  const timezone = args.timezone ?? DEFAULT_TENANT_TIMEZONE;
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
    scheduledStart: resolved.startUtc,
    scheduledEnd: resolved.endUtc,
    timezone: resolved.timezone,
    ...(arrival ? { arrival } : {}),
  };
}
