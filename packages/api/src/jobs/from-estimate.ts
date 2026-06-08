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
  createAppointment,
} from '../appointments/appointment';
import {
  AppointmentAssignment,
  AssignmentRepository,
  assignTechnician,
  syncJobAssignment,
} from '../appointments/assignment';
import { UserRepository, User } from '../users/user';
import { InvoiceRepository } from '../invoices/invoice';
import { RefreshJobMoneyStateDeps } from './job-money-state';
import { findBookableSlots, isSlotFree } from '../scheduling/booking-availability';
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
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
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

  // Operator pinned an exact start: verify it's free for the chosen tech.
  if (input.scheduledStart) {
    const tech = candidates[0];
    const scheduledStart = input.scheduledStart;
    const scheduledEnd = new Date(scheduledStart.getTime() + durationMin * 60_000);
    const free = await isSlotFree(slotDeps, {
      tenantId, start: scheduledStart, end: scheduledEnd, technicianId: tech.id,
    });
    if (!free) {
      throw new ConflictError('Requested start time is not available for the technician');
    }
    return { technicianId: tech.id, technicianRole: tech.role, scheduledStart, scheduledEnd };
  }

  // Auto-pick the first technician with an open slot in the search window.
  const fromDate = ymd(now);
  const toDate = ymd(new Date(now.getTime() + SCHEDULE_WINDOW_DAYS * 86_400_000));
  for (const tech of candidates) {
    const slots = await findBookableSlots(slotDeps, {
      tenantId, fromDate, toDate, timezone, durationMin, technicianId: tech.id, maxSlots: 1, now,
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

  // 3. Choose a technician + conflict-free slot.
  const chosen = await chooseTechnicianAndSlot(deps, input);

  // 4. Create the appointment, then assign the primary technician (the
  //    assign step's double-booking guard + DB EXCLUDE constraint are the
  //    authoritative protections).
  const appointment = await createAppointment(
    {
      tenantId,
      jobId: job.id,
      scheduledStart: chosen.scheduledStart,
      scheduledEnd: chosen.scheduledEnd,
      timezone,
      createdBy: actorId,
    },
    deps.appointmentRepo,
    undefined,
    deps.auditRepo,
    input.actorRole,
  );

  let assignment: AppointmentAssignment;
  try {
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
    // Compensate: cancel the just-created appointment rather than leave an
    // unassigned orphan behind when the assign step fails (e.g. a race lost to
    // the no_double_booking constraint).
    try {
      await deps.appointmentRepo.update(tenantId, appointment.id, { status: 'canceled' });
    } catch {
      // best-effort compensation; surface the original error below
    }
    throw err;
  }

  // 5. Denormalize the primary tech onto the job.
  await syncJobAssignment(tenantId, job.id, appointment.id, deps.assignmentRepo, deps.jobRepo);

  // 6. Accept the estimate (skip if already accepted). The one-accepted-per-job
  //    DB index (migration 129) is the race-safe backstop; a loser surfaces as
  //    a ConflictError from the Pg layer.
  let acceptedEstimate = estimate;
  if (estimate.status === 'sent') {
    // Pass money-state deps so the job's denormalized `moneyState` rolls up to
    // estimate_accepted — downstream auto-invoice + the invoicing queue filter
    // on it, so skipping this leaves converted jobs stuck at estimate_sent.
    const moneyStateDeps: RefreshJobMoneyStateDeps = {
      jobRepo: deps.jobRepo,
      estimateRepo: deps.estimateRepo,
      invoiceRepo: deps.invoiceRepo,
      auditRepo: deps.auditRepo,
    };
    const updated = await transitionEstimateStatus(
      tenantId, estimateId, 'accepted', deps.estimateRepo, moneyStateDeps,
    );
    if (updated) acceptedEstimate = updated;
  }

  // 7. Audit the conversion as a single domain event.
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

  // 8. Return the job with its freshly-synced assignedTechnicianId.
  const refreshedJob = (await getJob(tenantId, job.id, deps.jobRepo)) ?? job;

  return { job: refreshedJob, appointment, assignment, estimate: acceptedEstimate };
}
