/**
 * Direct job scheduling — project a job's schedule intent onto a linked
 * appointment (+ a primary appointment assignment) so the job reaches the
 * dispatch board and Schedule calendar. The board reads `appointments`
 * (grouped by their primary `appointment_assignments` row), never `jobs`;
 * jobs have no `scheduled_at` column. This is the non-estimate counterpart
 * of `from-estimate.ts` (which is left untouched per the plan).
 *
 * One CANONICAL appointment per job-schedule, keyed by the tech/slot-
 * independent idempotency key `job-schedule:<jobId>`, so repeated saves and
 * reschedules resolve to the same row (upsert) rather than duplicating. On
 * cancel the key is RELEASED (set NULL) so a later schedule creates a fresh
 * row instead of reviving the canceled one.
 *
 * Atomicity precondition: `syncJobSchedule` performs NO compensation of its
 * own — it MUST be called inside the request transaction
 * (`withTenantTransaction`, which wraps `/api`). Any thrown error (a
 * `ConflictError` from the assignment pre-flight, or a DB `23P01` from the
 * reschedule trigger) rolls back the whole request — job row, appointment,
 * assignment and audit together. It must never be invoked outside that
 * transactional scope.
 */
import {
  Appointment,
  AppointmentRepository,
  AppointmentStatus,
  CreateAppointmentInput,
  createAppointment,
  validateAppointmentInput,
} from '../appointments/appointment';
import { validateAppointmentTimes } from '../appointments/validation';
import {
  AssignmentRepository,
  assignTechnician,
  syncJobAssignment,
  unassignTechnician,
} from '../appointments/assignment';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { UserRepository } from '../users/user';
import { Job, JobRepository, getJob } from './job';
import { JobTimelineRepository, isPostCompletionStatus, transitionJobStatus } from './job-lifecycle';

const DEFAULT_DURATION_MIN = 60;
const DEFAULT_TIMEZONE = 'UTC';

// The direct-schedule path only manages an appointment that has not yet started
// — once it's in_progress / completed / no_show / canceled it is owned by the
// appointment lifecycle, not this projection, and must never be force-mutated.
const SCHEDULABLE_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  'scheduled',
  'confirmed',
]);

/** Stable, tech/slot-independent idempotency key for a job's canonical schedule. */
export function jobScheduleKey(jobId: string): string {
  return `job-schedule:${jobId}`;
}

export interface JobAppointmentSyncDeps {
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  userRepo: UserRepository;
  timelineRepo: JobTimelineRepository;
  auditRepo?: AuditRepository;
}

interface BaseInput {
  tenantId: string;
  jobId: string;
  actorId: string;
  actorRole: string;
}

export type SyncJobScheduleInput =
  | (BaseInput & {
      /** Initial schedule OR reschedule (idempotent upsert by key). */
      operation: 'schedule';
      scheduledStart: Date;
      durationMin?: number;
      /** Set the primary technician. Omit to leave the assignment untouched. */
      technicianId?: string;
      timezone?: string;
    })
  | (BaseInput & {
      /** Change or CLEAR (null) the primary technician; keep the slot. */
      operation: 'reassign';
      technicianId: string | null;
    })
  | (BaseInput & {
      /** Cancel the appointment and revert the job scheduled → new. */
      operation: 'unschedule';
      reason?: string;
    })
  | (BaseInput & {
      /** Cancel the appointment because the job itself was canceled (no status revert). */
      operation: 'cancelForJob';
    });

export interface SyncJobScheduleResult {
  /** The live appointment after the op, or null when there is no active schedule. */
  appointment: Appointment | null;
  /** The appointment's start before a reschedule/cancel — lets the route notify the old board day. */
  previousScheduledStart?: Date;
}

/**
 * Resolve the job's CANONICAL schedule appointment (our key, not canceled).
 * Scoped strictly to our key so an estimate-created appointment on the same
 * job is never hijacked.
 */
async function findCanonicalAppointment(
  deps: JobAppointmentSyncDeps,
  tenantId: string,
  jobId: string,
): Promise<Appointment | undefined> {
  const key = jobScheduleKey(jobId);
  const all = await deps.appointmentRepo.findByJob(tenantId, jobId);
  // Only a not-yet-started appointment (scheduled/confirmed) is reschedulable
  // or cancelable here. An in_progress/completed/no_show visit under the same
  // key is left to the appointment lifecycle — never force-mutated.
  return all.find((a) => a.idempotencyKey === key && SCHEDULABLE_STATUSES.has(a.status));
}

/**
 * Make `technicianId` the appointment's primary assignment (or, when null,
 * clear it — moving the appointment to the board's unassigned queue). The
 * assignment pre-flight in `assignTechnician` surfaces a double-booking as a
 * `ConflictError` BEFORE any DB write, so a conflict never poisons the txn.
 */
async function ensurePrimaryTechnician(
  deps: JobAppointmentSyncDeps,
  tenantId: string,
  appointmentId: string,
  technicianId: string | null,
  actorId: string,
  actorRole: string,
): Promise<void> {
  const assignments = await deps.assignmentRepo.findByAppointment(tenantId, appointmentId);
  const currentPrimary = assignments.find((a) => a.isPrimary);

  // Clear the technician — leave the appointment unassigned.
  if (technicianId === null) {
    if (currentPrimary) {
      await unassignTechnician(tenantId, currentPrimary.id, deps.assignmentRepo, {
        auditRepo: deps.auditRepo,
        actorId,
        actorRole,
        appointmentId,
        technicianId: currentPrimary.technicianId,
      });
    }
    return;
  }

  // Already the primary — no-op (avoids a needless unassign/reassign churn).
  if (currentPrimary && currentPrimary.technicianId === technicianId) return;

  // Tenant-scoped role check: the assignee must be a technician.
  const user = await deps.userRepo.findById(tenantId, technicianId);
  if (!user || user.role !== 'technician') {
    throw new ValidationError('technicianId must reference a user with the technician role');
  }

  if (currentPrimary) {
    await unassignTechnician(tenantId, currentPrimary.id, deps.assignmentRepo, {
      auditRepo: deps.auditRepo,
      actorId,
      actorRole,
      appointmentId,
      technicianId: currentPrimary.technicianId,
    });
  }

  await assignTechnician(
    {
      tenantId,
      appointmentId,
      technicianId,
      technicianRole: user.role,
      isPrimary: true,
      assignedBy: actorId,
    },
    deps.assignmentRepo,
    { appointmentRepo: deps.appointmentRepo, auditRepo: deps.auditRepo, actorRole },
  );
}

async function emitJobScheduleAudit(
  deps: JobAppointmentSyncDeps,
  tenantId: string,
  jobId: string,
  actorId: string,
  actorRole: string,
  eventType: 'job.scheduled' | 'job.reassigned' | 'job.unscheduled',
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId,
      actorRole,
      eventType,
      entityType: 'job',
      entityId: jobId,
      metadata,
    }),
  );
}

export async function syncJobSchedule(
  deps: JobAppointmentSyncDeps,
  input: SyncJobScheduleInput,
): Promise<SyncJobScheduleResult> {
  const { tenantId, jobId, actorId, actorRole } = input;

  const job = await getJob(tenantId, jobId, deps.jobRepo);
  if (!job) throw new NotFoundError('Job', jobId);

  const existing = await findCanonicalAppointment(deps, tenantId, jobId);

  if (input.operation === 'schedule') {
    // A terminal job must not be put back on the board by creating a live
    // appointment: maybeAdvanceToScheduled only moves 'new' jobs, so a
    // canceled/completed/invoiced/closed job would keep its terminal status
    // while a fresh appointment appears on the (status-blind) date-based board.
    if (job.status === 'canceled' || isPostCompletionStatus(job.status)) {
      throw new ConflictError(`Cannot schedule a ${job.status} job`);
    }

    const timezone = input.timezone ?? DEFAULT_TIMEZONE;
    const scheduledStart = input.scheduledStart;

    let appointment: Appointment;
    let previousScheduledStart: Date | undefined;

    if (existing) {
      // Reschedule the SAME canonical row.
      //
      // PRESERVE the existing slot length unless the caller explicitly passes a
      // new durationMin — moving only the start time must not silently resize
      // the appointment (a 90-min visit rescheduled must stay 90 min).
      previousScheduledStart = existing.scheduledStart;

      // Compute + validate the new window BEFORE any mutation, so an invalid
      // request fails fast without touching assignments.
      const durationMs =
        input.durationMin !== undefined
          ? input.durationMin * 60_000
          : existing.scheduledEnd.getTime() - existing.scheduledStart.getTime();
      const scheduledEnd = new Date(scheduledStart.getTime() + durationMs);
      const errs = validateAppointmentTimes({ scheduledStart, scheduledEnd }).errors;
      if (errs.length > 0) throw new ValidationError(`Invalid appointment: ${errs.join(', ')}`);

      // Combined move (new time AND new tech): the TARGET must be validated
      // against the NEW window, but assignTechnician's double-booking pre-flight
      // reads the appointment's CURRENT time from the repo. So the correct order
      // is DETACH the old tech → MOVE the time → ATTACH the new tech:
      //  - Detaching first stops the appointment-time UPDATE (which re-stamps
      //    the still-attached primary's window via the DB trigger) from 409-ing
      //    on the OLD tech's availability at the new window — we're moving off
      //    them anyway.
      //  - Attaching last means the target's pre-flight (and the DB EXCLUDE
      //    backstop `no_double_booking`) check the NEW window: a valid move into
      //    a slot the target is free for is accepted, and a real clash caught.
      // Leaving the tech untouched (technicianId undefined) or re-selecting the
      // same tech keeps them attached, so the time UPDATE re-stamps their window
      // and the DB trigger correctly checks that same tech at the new slot.
      const currentPrimary = (await deps.assignmentRepo.findByAppointment(tenantId, existing.id)).find(
        (a) => a.isPrimary,
      );
      const currentPrimaryTech = currentPrimary?.technicianId ?? null;
      const changingTech =
        input.technicianId !== undefined && input.technicianId !== currentPrimaryTech;

      if (changingTech && currentPrimary) {
        await unassignTechnician(tenantId, currentPrimary.id, deps.assignmentRepo, {
          auditRepo: deps.auditRepo,
          actorId,
          actorRole,
          appointmentId: existing.id,
          technicianId: currentPrimary.technicianId,
        });
      }

      const updated = await deps.appointmentRepo.update(tenantId, existing.id, {
        scheduledStart,
        scheduledEnd,
        updatedAt: new Date(),
      });
      if (!updated) throw new NotFoundError('Appointment', existing.id);
      appointment = updated;

      // Attach the target AFTER the move so its double-booking check sees the
      // new window. null = leave unassigned (already detached above). The
      // `!== undefined` re-narrows for the type checker (changingTech already
      // implies it).
      if (changingTech && input.technicianId !== undefined && input.technicianId !== null) {
        await ensurePrimaryTechnician(deps, tenantId, appointment.id, input.technicianId, actorId, actorRole);
      }
    } else {
      const durationMin = input.durationMin ?? DEFAULT_DURATION_MIN;
      const scheduledEnd = new Date(scheduledStart.getTime() + durationMin * 60_000);
      const createInput: CreateAppointmentInput = {
        tenantId,
        jobId,
        scheduledStart,
        scheduledEnd,
        timezone,
        idempotencyKey: jobScheduleKey(jobId),
        createdBy: actorId,
      };
      const inputErrors = [
        ...validateAppointmentInput(createInput),
        ...validateAppointmentTimes(createInput).errors,
      ];
      if (inputErrors.length > 0) {
        throw new ValidationError(`Invalid appointment: ${inputErrors.join(', ')}`);
      }
      appointment = await createAppointment(
        createInput,
        deps.appointmentRepo,
        undefined,
        deps.auditRepo,
        actorRole,
      );
      // createAppointment dedupes on the canonical key (ON CONFLICT). If the
      // key was already held by a started/finished visit (a concurrent insert,
      // or a completed appointment whose key wasn't released), the returned row
      // is NOT a fresh scheduled one — refuse rather than re-stamp its time.
      if (!SCHEDULABLE_STATUSES.has(appointment.status)) {
        throw new ConflictError(
          'Job already has an active appointment that cannot be rescheduled here',
        );
      }
      // A fresh appointment must exist before it can carry an assignment.
      // (Technician is optional — undefined leaves it unassigned.)
      if (input.technicianId !== undefined) {
        await ensurePrimaryTechnician(deps, tenantId, appointment.id, input.technicianId, actorId, actorRole);
      }
    }

    await syncJobAssignment(tenantId, jobId, appointment.id, deps.assignmentRepo, deps.jobRepo);

    await maybeAdvanceToScheduled(deps, job, actorId, actorRole);
    await emitJobScheduleAudit(deps, tenantId, jobId, actorId, actorRole, 'job.scheduled', {
      appointmentId: appointment.id,
      scheduledStart: scheduledStart.toISOString(),
      rescheduled: Boolean(existing),
    });

    return { appointment, previousScheduledStart };
  }

  if (input.operation === 'reassign') {
    if (!existing) {
      throw new ConflictError('Job has no scheduled appointment to reassign');
    }
    await ensurePrimaryTechnician(deps, tenantId, existing.id, input.technicianId, actorId, actorRole);
    await syncJobAssignment(tenantId, jobId, existing.id, deps.assignmentRepo, deps.jobRepo);
    await emitJobScheduleAudit(deps, tenantId, jobId, actorId, actorRole, 'job.reassigned', {
      appointmentId: existing.id,
      technicianId: input.technicianId,
    });
    // Reassign keeps the slot, so there is no "previous day" to also notify.
    return { appointment: existing };
  }

  // unschedule | cancelForJob — both cancel the canonical appointment.
  if (!existing) {
    // Idempotent no-op: nothing scheduled to cancel.
    return { appointment: null };
  }

  const previousScheduledStart = existing.scheduledStart;

  // Cancel via the REPO update (not the validating wrapper) and release the
  // key so a future schedule creates a fresh row.
  await deps.appointmentRepo.update(tenantId, existing.id, {
    status: 'canceled',
    idempotencyKey: null,
    updatedAt: new Date(),
  });

  // Drop the primary assignment so the slot frees and the denormalized
  // technician on the job is cleared.
  const assignments = await deps.assignmentRepo.findByAppointment(tenantId, existing.id);
  const primary = assignments.find((a) => a.isPrimary);
  if (primary) {
    await unassignTechnician(tenantId, primary.id, deps.assignmentRepo, {
      auditRepo: deps.auditRepo,
      actorId,
      actorRole,
      appointmentId: existing.id,
      technicianId: primary.technicianId,
    });
  }
  await syncJobAssignment(tenantId, jobId, existing.id, deps.assignmentRepo, deps.jobRepo);

  if (input.operation === 'unschedule') {
    // Structural revert to new (system-authorized backward move). Covers any
    // forward, pre-completion status the job reached while scheduled
    // (scheduled / dispatched / in_progress) — not just 'scheduled' — so a
    // dispatched job that's unscheduled doesn't strand in a forward status
    // with no appointment. Post-completion (completed/invoiced/closed) and
    // canceled are left alone (and transitionJobStatus would refuse them).
    if (job.status !== 'new' && job.status !== 'canceled' && !isPostCompletionStatus(job.status)) {
      await transitionJobStatus(
        tenantId,
        jobId,
        'new',
        actorId,
        'system',
        deps.jobRepo,
        deps.timelineRepo,
        deps.auditRepo,
        input.reason ?? 'Schedule cleared',
      );
    }
    await emitJobScheduleAudit(deps, tenantId, jobId, actorId, actorRole, 'job.unscheduled', {
      appointmentId: existing.id,
    });
  }

  return { appointment: null, previousScheduledStart };
}

/** First-time schedule advances new → scheduled (forward; any role). Idempotent. */
async function maybeAdvanceToScheduled(
  deps: JobAppointmentSyncDeps,
  job: Job,
  actorId: string,
  actorRole: string,
): Promise<void> {
  if (job.status !== 'new') return;
  await transitionJobStatus(
    job.tenantId,
    job.id,
    'scheduled',
    actorId,
    actorRole,
    deps.jobRepo,
    deps.timelineRepo,
    deps.auditRepo,
  );
}
