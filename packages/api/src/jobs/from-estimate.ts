/**
 * Feature 5 — Estimate → Job conversion (launch-readiness pass).
 *
 * `POST /api/jobs/from-estimate/:estimateId` schedules and assigns the job that
 * an accepted/sent estimate already belongs to, then flips the estimate to
 * `accepted`. The product is job-first (every estimate carries a mandatory
 * jobId), so this REUSES the estimate's existing job rather than minting a
 * second one — that keeps the one-accepted-estimate-per-job invariant
 * (migration 129) and the estimate→invoice idempotency (findByJob) intact.
 *
 * Scheduling is modeled by an appointment + a primary appointment assignment
 * (jobs have no scheduled_at column); the chosen technician is also
 * denormalized onto job.assignedTechnicianId via syncJobAssignment.
 *
 * Tech selection is skill+availability based. SkillMatcher is currently a stub
 * (returns no required skills), so selection degrades to "first technician with
 * an open slot"; an operator can override technician and/or start time.
 */
import { EstimateRepository, Estimate, transitionEstimateStatus } from '../estimates/estimate';
import { Job, JobRepository, getJob } from './job';
import {
  Appointment,
  AppointmentRepository,
  CreateAppointmentInput,
  createAppointment,
  validateAppointmentInput,
} from '../appointments/appointment';
import { validateAppointmentTimes } from '../appointments/validation';
import {
  AppointmentAssignment,
  AssignmentRepository,
  assignTechnician,
  syncJobAssignment,
} from '../appointments/assignment';
import { UserRepository, User } from '../users/user';
import { InvoiceRepository } from '../invoices/invoice';
import { RefreshJobMoneyStateDeps } from './job-money-state';
import {
  findBookableSlots,
  isSlotFree,
  schedulingConfigFromSettings,
} from '../scheduling/booking-availability';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { NotFoundError, ConflictError, ValidationError } from '../shared/errors';
import { isValidTenantId } from '../db/schema';

const DEFAULT_DURATION_MIN = 60;
const DEFAULT_TIMEZONE = 'UTC';
const SCHEDULE_WINDOW_DAYS = 14;

export interface ConvertEstimateToScheduledJobDeps {
  estimateRepo: EstimateRepository;
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  userRepo: UserRepository;
  /** Needed to roll up job.money_state when the estimate is accepted. */
  invoiceRepo: InvoiceRepository;
  auditRepo?: AuditRepository;
  /**
   * When wired, tenant scheduling settings (timezone, business hours, travel
   * buffer) constrain auto-picked slots instead of the hardcoded defaults.
   */
  settingsRepo?: SettingsRepository;
}

export interface ConvertEstimateToScheduledJobInput {
  tenantId: string;
  estimateId: string;
  actorId: string;
  actorRole?: string;
  /** Appointment length in minutes. Default 60. */
  durationMin?: number;
  /** Operator override: assign this technician (must have the technician role). */
  technicianId?: string;
  /** Operator override: schedule at this exact start (must be free). */
  scheduledStart?: Date;
  /** Display timezone for the appointment. Default UTC. */
  timezone?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface ConvertEstimateToScheduledJobResult {
  job: Job;
  appointment: Appointment;
  assignment: AppointmentAssignment;
  estimate: Estimate;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ChosenSlot {
  technicianId: string;
  technicianRole: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

async function chooseTechnicianAndSlot(
  deps: ConvertEstimateToScheduledJobDeps,
  input: ConvertEstimateToScheduledJobInput,
): Promise<ChosenSlot> {
  const { tenantId } = input;
  const durationMin = input.durationMin ?? DEFAULT_DURATION_MIN;
  const settings = deps.settingsRepo
    ? await deps.settingsRepo.findByTenant(tenantId).catch(() => null)
    : null;
  const schedulingConfig = schedulingConfigFromSettings(settings);
  const timezone = input.timezone ?? schedulingConfig.timezone ?? DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();
  const slotDeps = { appointmentRepo: deps.appointmentRepo, assignmentRepo: deps.assignmentRepo };

  async function requireTechnician(id: string): Promise<User> {
    const user = await deps.userRepo.findById(tenantId, id);
    if (!user || user.role !== 'technician') {
      throw new ValidationError('technicianId must reference a user with the technician role');
    }
    return user;
  }

  // Candidate set: an explicit technician, otherwise every technician. (Skill
  // narrowing is a no-op until a real SkillMatcher exists.)
  const candidates: User[] = input.technicianId
    ? [await requireTechnician(input.technicianId)]
    : await deps.userRepo.findByTenant(tenantId, { role: 'technician' });
  if (candidates.length === 0) {
    throw new ConflictError('No technicians available to schedule this job');
  }

  // Operator pinned an exact start: assign the first candidate free at that
  // time. When technicianId was also given, candidates is just that tech; when
  // it wasn't, we search every technician rather than only the first-created
  // one (otherwise a pinned start fails when tech #1 is busy but others are free).
  if (input.scheduledStart) {
    const scheduledStart = input.scheduledStart;
    const scheduledEnd = new Date(scheduledStart.getTime() + durationMin * 60_000);
    for (const tech of candidates) {
      const free = await isSlotFree(slotDeps, {
        tenantId, start: scheduledStart, end: scheduledEnd, technicianId: tech.id,
      });
      if (free) {
        return { technicianId: tech.id, technicianRole: tech.role, scheduledStart, scheduledEnd };
      }
    }
    throw new ConflictError('Requested start time is not available for any technician');
  }

  // Auto-pick the first technician with an open slot in the search window.
  const fromDate = ymd(now);
  const toDate = ymd(new Date(now.getTime() + SCHEDULE_WINDOW_DAYS * 86_400_000));
  for (const tech of candidates) {
    const slots = await findBookableSlots(slotDeps, {
      tenantId, fromDate, toDate, timezone, durationMin, technicianId: tech.id, maxSlots: 1, now,
      weeklyHours: schedulingConfig.weeklyHours,
      bufferMinutes: schedulingConfig.bufferMinutes,
    });
    if (slots.length > 0) {
      return {
        technicianId: tech.id,
        technicianRole: tech.role,
        scheduledStart: slots[0].start,
        scheduledEnd: slots[0].end,
      };
    }
  }
  throw new ConflictError(
    'Could not auto-schedule: no open slot for any technician in the next ' +
      `${SCHEDULE_WINDOW_DAYS} days. Provide technicianId + scheduledStart to override.`,
  );
}

export async function convertEstimateToScheduledJob(
  deps: ConvertEstimateToScheduledJobDeps,
  input: ConvertEstimateToScheduledJobInput,
): Promise<ConvertEstimateToScheduledJobResult> {
  const { tenantId, estimateId, actorId } = input;
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;

  // 0. Validate UUIDs up front so a malformed id can't reach a tenant-scoped
  //    query / setTenantContext (which casts to uuid) before failing.
  if (!isValidTenantId(tenantId)) throw new ValidationError('Invalid tenant ID format');
  if (!isValidTenantId(estimateId)) throw new ValidationError('Invalid estimate ID format');
  if (input.technicianId && !isValidTenantId(input.technicianId)) {
    throw new ValidationError('Invalid technician ID format');
  }

  // 1. Load + guard the estimate. Only a 'sent' estimate can be accepted; an
  //    already-'accepted' one is idempotent-safe (we just (re)schedule).
  const estimate = await deps.estimateRepo.findById(tenantId, estimateId);
  if (!estimate) throw new NotFoundError('Estimate', estimateId);
  if (estimate.status !== 'sent' && estimate.status !== 'accepted') {
    throw new ConflictError(
      `Estimate must be 'sent' before converting to a scheduled job (current status: ${estimate.status})`,
    );
  }

  // 2. Reuse the estimate's existing job (estimates are job-linked).
  const job = await getJob(tenantId, estimate.jobId, deps.jobRepo);
  if (!job) throw new NotFoundError('Job', estimate.jobId);

  // 2b. Pre-flight the one-accepted-estimate-per-job rule BEFORE any scheduling.
  //     Accepting this 'sent' estimate when the job already has a different
  //     accepted estimate would 409 on the migration-129 unique index — but that
  //     check currently runs after the appointment + assignment are created,
  //     leaving orphan side effects behind a failed conversion. Fail closed here,
  //     before scheduling. The DB index remains the race-safe backstop.
  if (estimate.status === 'sent') {
    const jobEstimates = await deps.estimateRepo.findByJob(tenantId, job.id);
    const otherAccepted = jobEstimates.find((e) => e.id !== estimateId && e.status === 'accepted');
    if (otherAccepted) {
      throw new ConflictError(
        `Job already has an accepted estimate (${otherAccepted.id}); cannot convert estimate ${estimateId}`,
      );
    }
  }

  // Idempotency key, computed from the REQUEST (not the chosen slot): identical
  // requests (a network retry / duplicate click) dedupe, while a deliberate
  // override (different tech or start) gets a distinct key. Auto selection uses
  // stable 'auto' tokens so plain retries still dedupe.
  const techKey = input.technicianId ?? 'auto';
  const slotKey = input.scheduledStart ? input.scheduledStart.toISOString() : 'auto';
  const idempotencyKey = `from-estimate:${estimateId}:${techKey}:${slotKey}`;

  // Accept a 'sent' estimate (idempotent; no-op when already accepted), rolling
  // up the job's money-state. Shared by the short-circuit and normal paths.
  const acceptEstimate = async (): Promise<Estimate> => {
    if (estimate.status !== 'sent') return estimate;
    const moneyStateDeps: RefreshJobMoneyStateDeps = {
      jobRepo: deps.jobRepo,
      estimateRepo: deps.estimateRepo,
      invoiceRepo: deps.invoiceRepo,
      auditRepo: deps.auditRepo,
    };
    const updated = await transitionEstimateStatus(
      tenantId, estimateId, 'accepted', deps.estimateRepo, moneyStateDeps,
    );
    return updated ?? estimate;
  };

  // 3. Idempotent short-circuit. If this exact conversion already produced a
  //    completed appointment, return it WITHOUT re-running slot selection —
  //    otherwise the conversion's OWN prior appointment makes isSlotFree report a
  //    conflict on a pinned retry (and the request fails before dedup can fire).
  const existingForKey = (await deps.appointmentRepo.findByJob(tenantId, job.id)).find(
    (a) => a.idempotencyKey === idempotencyKey && a.status !== 'canceled',
  );
  if (existingForKey) {
    const priors = await deps.assignmentRepo.findByAppointment(tenantId, existingForKey.id);
    const primary = priors.find((a) => a.isPrimary);
    if (primary) {
      // Complete any sync a prior attempt may have died before finishing
      // (idempotent), so the returned job's assignedTechnicianId isn't stale.
      await syncJobAssignment(tenantId, job.id, existingForKey.id, deps.assignmentRepo, deps.jobRepo);
      const acceptedEstimate = await acceptEstimate();
      const refreshedJob = (await getJob(tenantId, job.id, deps.jobRepo)) ?? job;
      return { job: refreshedJob, appointment: existingForKey, assignment: primary, estimate: acceptedEstimate };
    }
    // Prior appointment exists but its assignment didn't complete — fall through
    // to finish it (createAppointment dedupes back to this row by key).
  }

  // 4. Validate feasibility (read-only) BEFORE committing acceptance. Choosing a
  //    technician + slot has no side effects, so an infeasible schedule (no
  //    technician, or an unavailable pinned start) throws HERE — before the
  //    estimate is accepted — rather than leaving it accepted-but-unscheduled
  //    with no retry path (these are permanent validation conflicts, not
  //    transient later-step failures).
  const chosen = await chooseTechnicianAndSlot(deps, input);

  // 5. Validate the appointment payload the SAME way createAppointment will
  //    (timezone in the supported set, duration <= 24h, time ordering) BEFORE
  //    committing acceptance. These are permanent validation conflicts: if they
  //    fired after accept, the estimate would be stranded accepted-but-
  //    unscheduled with no clean retry. Reused verbatim as the create payload.
  const appointmentInput: CreateAppointmentInput = {
    tenantId,
    jobId: job.id,
    scheduledStart: chosen.scheduledStart,
    scheduledEnd: chosen.scheduledEnd,
    timezone,
    createdBy: actorId,
    idempotencyKey,
  };
  const appointmentErrors = [
    ...validateAppointmentInput(appointmentInput),
    ...validateAppointmentTimes(appointmentInput).errors,
  ];
  if (appointmentErrors.length > 0) {
    throw new ValidationError(`Invalid appointment: ${appointmentErrors.join(', ')}`);
  }

  // 6. Accept the estimate BEFORE creating the appointment. The
  //    one-accepted-estimate-per-job DB index (migration 129) makes acceptance
  //    the atomic gate: under two concurrent conversions of different 'sent'
  //    estimates the loser throws HERE — before any appointment/assignment
  //    exists — so no orphan scheduling is left behind (the 2b read-check is
  //    only a friendly fast-fail and can't see a concurrent in-flight accept).
  //    A transient failure in a later step leaves the estimate accepted-but-
  //    unscheduled, which a retry completes (acceptEstimate is then a no-op).
  const acceptedEstimate = await acceptEstimate();

  // 7. Create the appointment (payload already validated above).
  let appointment = await createAppointment(
    appointmentInput,
    deps.appointmentRepo,
    undefined,
    deps.auditRepo,
    input.actorRole,
  );

  // A retry whose prior attempt failed at the assign step left a CANCELED
  // appointment under this same idempotency key; createAppointment dedupes back
  // to it. Revive it rather than binding the job to a canceled appointment.
  if (appointment.status === 'canceled') {
    const revived = await deps.appointmentRepo.update(tenantId, appointment.id, { status: 'scheduled' });
    if (revived) appointment = revived;
  }

  // 8. Assign the primary technician. If the appointment already carries a
  //    primary (a completed prior attempt deduped here), reuse it — never
  //    reassign a (possibly different) chosen tech onto a pre-existing slot.
  const priorAssignments = await deps.assignmentRepo.findByAppointment(tenantId, appointment.id);
  const existing = priorAssignments.find((a) => a.isPrimary);
  let assignment: AppointmentAssignment;
  if (existing) {
    assignment = existing;
  } else try {
    assignment = await assignTechnician(
      {
        tenantId,
        appointmentId: appointment.id,
        technicianId: chosen.technicianId,
        technicianRole: chosen.technicianRole,
        isPrimary: true,
        assignedBy: actorId,
      },
      deps.assignmentRepo,
      { appointmentRepo: deps.appointmentRepo, auditRepo: deps.auditRepo, actorRole: input.actorRole },
    );
  } catch (err) {
    // Compensate ONLY when we created a fresh appointment (no prior assignments);
    // never cancel an appointment that already existed from a prior run. The
    // canceled row's key is revived on a later retry (see the revive step above).
    if (priorAssignments.length === 0) {
      try {
        await deps.appointmentRepo.update(tenantId, appointment.id, { status: 'canceled' });
      } catch {
        // best-effort compensation; surface the original error below
      }
    }
    throw err;
  }

  // 9. Denormalize the primary tech onto the job.
  await syncJobAssignment(tenantId, job.id, appointment.id, deps.assignmentRepo, deps.jobRepo);

  // 10. Audit the conversion as a single domain event.
  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: input.actorRole ?? 'user',
        eventType: 'job.created_from_estimate',
        entityType: 'job',
        entityId: job.id,
        metadata: {
          estimateId,
          appointmentId: appointment.id,
          technicianId: chosen.technicianId,
          scheduledStart: chosen.scheduledStart.toISOString(),
        },
      }),
    );
  }

  // 11. Return the job with its freshly-synced assignedTechnicianId.
  const refreshedJob = (await getJob(tenantId, job.id, deps.jobRepo)) ?? job;

  return { job: refreshedJob, appointment, assignment, estimate: acceptedEstimate };
}
