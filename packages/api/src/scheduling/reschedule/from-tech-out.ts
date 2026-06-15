import {
  Appointment,
  AppointmentRepository,
} from '../../appointments/appointment';
import { AssignmentRepository } from '../../appointments/assignment';
import { CustomerRepository } from '../../customers/customer';
import { JobRepository } from '../../jobs/job';
import {
  Proposal,
  ProposalRepository,
  createProposal,
} from '../../proposals/proposal';
import { rescheduleAppointmentPayloadSchema } from '../../proposals/contracts/reschedule';
import { ConflictError } from '../../shared/errors';
import type { ComposeBrandVoiceDeps } from '../../ai/brand-voice/composer';
import { draftCustomerRescheduleMessage } from './customer-message-draft';

/**
 * P6-028 — when a technician marks themselves OUT for the day, walk their
 * remaining appointments for the rest of the (tenant-local) day and create one
 * `reschedule_appointment` proposal per appointment, routed to the owner. Each
 * proposal carries a brand-voice customer SMS draft on `sourceContext.draftSms`
 * so the owner reviews the exact customer message before approving.
 *
 * Per CLAUDE.md "never auto-execute proposals" — these land in 'draft' (no
 * `sourceTrustTier` is passed, so `decideInitialStatus` keeps them gated). The
 * owner approves them (one at a time, or via "APPROVE ALL" / P2-035's batch
 * endpoint when 3+ are pending). The 3+ threshold is a CLIENT-side UX choice;
 * the backend just creates N proposals.
 *
 * Finding the tech's appointments uses the feasibility.ts precedent
 * (assignmentRepo.findByTechnician → appointmentRepo.findById per assignment),
 * NOT a non-existent `findUpcomingForTechnician`. We do not add methods to the
 * Tier-1-locked AppointmentRepository / AssignmentRepository interfaces.
 */

export interface RescheduleFromTechOutInput {
  tenantId: string;
  technicianId: string;
  /**
   * Lower bound (UTC instant) of the "remaining today" window — typically
   * `now`. Appointments that have already ended are skipped.
   */
  windowStart: Date;
  /**
   * Upper bound (UTC instant) of the window — typically tenant-local midnight
   * + 24h (end of the tech's local day).
   */
  windowEnd: Date;
  /** Stamped on the proposal `createdBy` (the system actor). */
  createdBy: string;
  /** Recorded on the proposal payload `reason` and sourceContext. */
  reason: string;
}

export interface RescheduleFromTechOutDeps {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  proposalRepo: ProposalRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  brandVoiceDeps: ComposeBrandVoiceDeps;
}

/**
 * Find the technician's appointments that are still pending in the window.
 * Mirrors feasibility.ts: fan out from assignments, dedupe, and keep those
 * whose scheduled window overlaps [windowStart, windowEnd) and that are not
 * already terminal (completed / canceled / no_show).
 */
export async function findRemainingAppointmentsToday(
  deps: Pick<RescheduleFromTechOutDeps, 'appointmentRepo' | 'assignmentRepo'>,
  tenantId: string,
  technicianId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Appointment[]> {
  const assignments = await deps.assignmentRepo.findByTechnician(
    tenantId,
    technicianId,
  );
  const seen = new Set<string>();
  const appts: Appointment[] = [];
  for (const a of assignments) {
    if (seen.has(a.appointmentId)) continue;
    seen.add(a.appointmentId);
    const appt = await deps.appointmentRepo.findById(tenantId, a.appointmentId);
    if (!appt) continue;
    // Same-day scope only: the appointment must still be running today
    // (ends after the window opens) and start before the window closes.
    if (appt.scheduledEnd <= windowStart) continue;
    if (appt.scheduledStart >= windowEnd) continue;
    // Skip appointments that are already done or off the board.
    if (
      appt.status === 'completed' ||
      appt.status === 'canceled' ||
      appt.status === 'no_show'
    ) {
      continue;
    }
    appts.push(appt);
  }
  return appts.sort(
    (x, y) => x.scheduledStart.getTime() - y.scheduledStart.getTime(),
  );
}

async function customerNameForAppointment(
  deps: Pick<RescheduleFromTechOutDeps, 'jobRepo' | 'customerRepo'>,
  tenantId: string,
  appt: Appointment,
): Promise<string | undefined> {
  const job = await deps.jobRepo.findById(tenantId, appt.jobId);
  if (!job?.customerId) return undefined;
  const customer = await deps.customerRepo.findById(tenantId, job.customerId);
  if (!customer) return undefined;
  const name = [customer.firstName, customer.lastName]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' ')
    .trim();
  return name.length > 0 ? name : undefined;
}

export interface RescheduleFromTechOutResult {
  proposals: Proposal[];
}

/**
 * Create one reschedule proposal per remaining appointment, each with a
 * brand-voice customer SMS draft attached on `sourceContext.draftSms`. Returns
 * the created proposals in scheduled-start order.
 */
export async function createRescheduleProposalsFromTechOut(
  input: RescheduleFromTechOutInput,
  deps: RescheduleFromTechOutDeps,
): Promise<RescheduleFromTechOutResult> {
  const appts = await findRemainingAppointmentsToday(
    deps,
    input.tenantId,
    input.technicianId,
    input.windowStart,
    input.windowEnd,
  );

  const proposals: Proposal[] = [];
  for (const appt of appts) {
    const customerName = await customerNameForAppointment(
      deps,
      input.tenantId,
      appt,
    );
    const appointmentTime = appt.scheduledStart.toISOString();

    const draft = await draftCustomerRescheduleMessage(
      {
        tenantId: input.tenantId,
        customerName,
        appointmentTime,
      },
      deps.brandVoiceDeps,
    );

    // The reschedule payload schema (FROZEN contract) requires
    // newScheduledStart / newScheduledEnd. The owner hasn't picked a new slot
    // yet, so we seed them with the CURRENT times — the proposal review UI is
    // where the owner edits to the real new slot before approving. reason
    // records why the reschedule was proposed.
    const payload = {
      appointmentId: appt.id,
      newScheduledStart: appt.scheduledStart.toISOString(),
      newScheduledEnd: appt.scheduledEnd.toISOString(),
      reason: input.reason,
    };
    // Validate against the frozen contract so a malformed payload never lands.
    rescheduleAppointmentPayloadSchema.parse(payload);

    const proposal = createProposal({
      tenantId: input.tenantId,
      proposalType: 'reschedule_appointment',
      payload,
      summary: customerName
        ? `Reschedule ${customerName}'s appointment — technician is ${input.reason}`
        : `Reschedule appointment — technician is ${input.reason}`,
      explanation:
        'The assigned technician marked themselves unavailable for the rest ' +
        'of the day. Approve to reschedule and notify the customer with the ' +
        'drafted message.',
      targetEntityType: 'appointment',
      targetEntityId: appt.id,
      promptVersionId: draft.promptVersionId,
      sourceContext: {
        // Tier-2-safe: the brand-voice customer SMS rides in sourceContext.
        draftSms: draft.text,
        techStatus: input.reason,
        technicianId: input.technicianId,
        // The payload is seeded with the appointment's CURRENT times (the owner
        // hasn't picked a new slot yet). This flag makes the reschedule
        // execution handler reject an approval that never changed the time, so
        // APPROVE ALL can't fire a no-op "we've rescheduled you" customer SMS.
        requiresSlotSelection: true,
      },
      // The proposals table requires a NOT NULL idempotency_key. A deterministic
      // per-appointment key also dedupes a retry: re-processing the same tech-out
      // won't mint a duplicate reschedule for an appointment already queued — the
      // unique (tenant_id, idempotency_key) index catches it (ConflictError,
      // handled below). Without this, proposalRepo.create hit a NOT NULL
      // violation that the in-memory repo could not surface (mocked-Pool gap).
      idempotencyKey: `tech-out-reschedule:${input.technicianId}:${appt.id}`,
      createdBy: input.createdBy,
    });

    let created: Proposal;
    try {
      created = await deps.proposalRepo.create(proposal);
    } catch (err) {
      // A prior (partial) attempt for this tech-out already queued this
      // appointment's reschedule — idempotent: skip, it's already in the queue.
      if (err instanceof ConflictError) continue;
      throw err;
    }
    // Surface in the owner's review queue. createProposal lands the proposal
    // in 'draft' (no sourceTrustTier ⇒ never auto-approve, per CLAUDE.md). The
    // owner approves from 'ready_for_review' (draft → ready_for_review →
    // approved), so we advance it here. Mirrors the low-confidence guardrail
    // path (ai/guardrails/low-confidence.ts).
    const queued =
      (await deps.proposalRepo.updateStatus(
        input.tenantId,
        created.id,
        'ready_for_review',
      )) ?? created;
    proposals.push(queued);
  }

  return { proposals };
}
