/**
 * Issue 2 (dispatch board) — scheduling a job auto-creates an appointment.
 *
 * The dispatch board renders *appointments*, not jobs (board-query.ts reads
 * appointmentRepo.findByDateRange). Before this, creating/booking a job left it
 * in status `new` with no appointment row, so a job "scheduled for today" never
 * appeared on the board or the Schedule calendar.
 *
 * `scheduleJob` closes that gap with model (a): it creates an UNASSIGNED
 * appointment for an existing job and moves the job `new -> scheduled`. The
 * appointment lands in the board's unassigned queue, where a dispatcher drags
 * it onto a technician lane (existing assignment flow). Technician assignment is
 * intentionally NOT done here — the board owns that step.
 *
 * Reuses the validated primitives so audit + timeline events fire for free:
 *   - createAppointment   -> emits `appointment.created`
 *   - transitionJobStatus -> emits `job.status_changed` + a timeline entry
 */
import { Job, JobRepository, getJob } from './job';
import { transitionJobStatus, JobTimelineRepository } from './job-lifecycle';
import {
  Appointment,
  AppointmentRepository,
  CreateAppointmentInput,
  createAppointment,
  validateAppointmentInput,
} from '../appointments/appointment';
import { validateAppointmentTimes } from '../appointments/validation';
import { AuditRepository } from '../audit/audit';
import { NotFoundError, ConflictError, ValidationError } from '../shared/errors';
import { isValidTenantId } from '../db/schema';

const DEFAULT_DURATION_MIN = 60;
const DEFAULT_TIMEZONE = 'UTC';

/** Statuses from which a job may still be (re)scheduled. */
const SCHEDULABLE_STATUSES: ReadonlySet<Job['status']> = new Set(['new', 'scheduled']);

export interface ScheduleJobDeps {
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  /** Required to record the `new -> scheduled` lifecycle transition. */
  timelineRepo: JobTimelineRepository;
  auditRepo?: AuditRepository;
}

export interface ScheduleJobInput {
  tenantId: string;
  jobId: string;
  scheduledStart: Date;
  /** Explicit end. When omitted, derived from `durationMin` (default 60). */
  scheduledEnd?: Date;
  /** Appointment length in minutes when `scheduledEnd` is not given. */
  durationMin?: number;
  /** Display timezone for the appointment. Defaults to UTC. */
  timezone?: string;
  notes?: string;
  actorId: string;
  actorRole?: string;
}

export interface ScheduleJobResult {
  job: Job;
  appointment: Appointment;
}

/**
 * Create an appointment for an existing job and move the job to `scheduled`.
 * The appointment is created unassigned so it surfaces in the dispatch board's
 * unassigned queue.
 */
export async function scheduleJob(
  deps: ScheduleJobDeps,
  input: ScheduleJobInput,
): Promise<ScheduleJobResult> {
  const { tenantId, jobId, actorId } = input;

  // Validate UUIDs up front so a malformed id can't reach a tenant-scoped query
  // / setTenantContext (which casts to uuid) before failing.
  if (!isValidTenantId(tenantId)) throw new ValidationError('Invalid tenant ID format');
  if (!isValidTenantId(jobId)) throw new ValidationError('Invalid job ID format');

  const job = await getJob(tenantId, jobId, deps.jobRepo);
  if (!job) throw new NotFoundError('Job', jobId);
  if (!SCHEDULABLE_STATUSES.has(job.status)) {
    throw new ConflictError(`Cannot schedule a job in status '${job.status}'`);
  }

  const scheduledEnd =
    input.scheduledEnd ??
    new Date(input.scheduledStart.getTime() + (input.durationMin ?? DEFAULT_DURATION_MIN) * 60_000);

  // Idempotency key derived from the request (job + exact slot) so a retry
  // after a lost response — the client treats a thrown schedule call as a
  // partial success — dedupes back to the same appointment instead of inserting
  // a duplicate dispatch-board card. Identical job+slot dedupes; a different
  // time is a distinct (re)schedule with its own key. Enforced by the unique
  // (tenant_id, idempotency_key) index (migration 135).
  const idempotencyKey =
    `schedule-job:${jobId}:${input.scheduledStart.toISOString()}:${scheduledEnd.toISOString()}`;

  const appointmentInput: CreateAppointmentInput = {
    tenantId,
    jobId,
    scheduledStart: input.scheduledStart,
    scheduledEnd,
    timezone: input.timezone ?? DEFAULT_TIMEZONE,
    notes: input.notes,
    idempotencyKey,
    createdBy: actorId,
  };

  // Validate the SAME way createAppointment will (timezone in the supported set,
  // duration <= 24h, time ordering) but surface a typed ValidationError so the
  // route returns 400 rather than the bare Error createAppointment would throw.
  const errors = [
    ...validateAppointmentInput(appointmentInput),
    ...validateAppointmentTimes(appointmentInput).errors,
  ];
  if (errors.length > 0) {
    throw new ValidationError(`Invalid appointment: ${errors.join(', ')}`);
  }

  // Create the board-critical artifact FIRST. If the status transition below
  // somehow fails, the job stays `new` but the appointment still exists, so it
  // renders on the board — the safer failure mode for the bug we're fixing.
  const appointment = await createAppointment(
    appointmentInput,
    deps.appointmentRepo,
    undefined,
    deps.auditRepo,
    input.actorRole,
  );

  // Move `new -> scheduled`. A job already `scheduled` (a reschedule / second
  // appointment) keeps its status; transitioning scheduled->scheduled is a
  // no-op the lifecycle would reject, so only advance from `new`.
  let scheduledJobRow = job;
  if (job.status === 'new') {
    const { job: updated } = await transitionJobStatus(
      tenantId,
      jobId,
      'scheduled',
      actorId,
      input.actorRole ?? 'unknown',
      deps.jobRepo,
      deps.timelineRepo,
      deps.auditRepo,
    );
    scheduledJobRow = updated;
  }

  return { job: scheduledJobRow, appointment };
}
