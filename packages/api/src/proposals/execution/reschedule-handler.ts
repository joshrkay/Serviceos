import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { resolveSurface } from '../surface';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';
import { AssignmentRepository } from '../../appointments/assignment';
import { validateAppointmentTimes } from '../../appointments/validation';
import { checkSchedulingProposalFreshness } from '../../ai/guardrails/scheduling-staleness';
import {
  DispatchAnalyticsRepository,
  captureDispatchEvent,
} from '../../dispatch/analytics';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { checkFeasibility } from '../../scheduling/feasibility';
import { FeasibilityDependencies, FeasibilityIssue } from '../../scheduling/feasibility-types';
import { TransactionalCommsService } from '../../notifications/transactional-comms-service';
import { notifyDispatchBoardChanged } from '../../dispatch/board-notify';
import { boardDateFromAppointment } from '../../dispatch/board-revision';

export class RescheduleAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'reschedule_appointment';
  // Awaits transactionalComms.notifyRescheduled (customer SMS/email) — external
  // network I/O alongside the appointment-reschedule DB write.
  // (notifyDispatchBoardChanged is a non-awaited in-process SSE signal and does
  // not count.)
  performsExternalIo = true;

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly feasibilityDeps?: FeasibilityDependencies,
    private readonly transactionalComms?: TransactionalCommsService,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const appointmentId = payload.appointmentId;
    if (!appointmentId || typeof appointmentId !== 'string') {
      return { success: false, error: 'Payload must include a valid appointmentId' };
    }

    const newScheduledStart = payload.newScheduledStart;
    if (!newScheduledStart || typeof newScheduledStart !== 'string') {
      return { success: false, error: 'Payload must include a valid newScheduledStart' };
    }

    const newScheduledEnd = payload.newScheduledEnd;
    if (!newScheduledEnd || typeof newScheduledEnd !== 'string') {
      return { success: false, error: 'Payload must include a valid newScheduledEnd' };
    }

    const startDate = new Date(newScheduledStart);
    const endDate = new Date(newScheduledEnd);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return { success: false, error: 'Invalid date format for scheduled times' };
    }

    // Validate times
    const validation = validateAppointmentTimes({
      scheduledStart: startDate,
      scheduledEnd: endDate,
      arrivalWindowStart: payload.newArrivalWindowStart ? new Date(payload.newArrivalWindowStart as string) : undefined,
      arrivalWindowEnd: payload.newArrivalWindowEnd ? new Date(payload.newArrivalWindowEnd as string) : undefined,
    });

    if (validation.errors.length > 0) {
      return { success: false, error: validation.errors.join(', ') };
    }

    // RIVET P4 — S1 ownership binding. The spec's allowlist grants an
    // unauthenticated caller "reschedule OWN appointment" only, but the voice
    // entity resolver searches appointments tenant-wide, so a caller naming
    // ANOTHER customer's appointment would otherwise sail through creation,
    // look routine in the owner's queue, and move a stranger's visit on
    // approval. Enforce OWN here, at execution, against the identity the
    // session stamped (caller-ID / self-signup — never transcript content).
    // Uses the SAME resolveSurface the executor enforces with — explicit
    // stamp OR the fail-safe inference (unstamped telephony + non-system
    // author) — so a legacy/unstamped inbound proposal cannot slip past the
    // ownership check that the executor's inference let through the
    // allowlist. Fail closed: an S1 reschedule with no verifiable caller
    // identity, or without the repos needed to verify, is refused.
    const isS1 =
      resolveSurface(
        proposal.sourceContext as Record<string, unknown> | undefined,
        proposal.createdBy,
      ) === 'S1';
    const callerCustomerId = proposal.sourceContext?.callerCustomerId;
    if (isS1 && (typeof callerCustomerId !== 'string' || callerCustomerId.length === 0)) {
      return {
        success: false,
        error:
          'Caller identity was not verified on this call — an S1 reschedule can only move ' +
          "the caller's own appointment. Handle this one manually.",
      };
    }
    if (isS1 && !this.appointmentRepo) {
      // Dev/passthrough wiring has no way to verify ownership — never let an
      // S1 reschedule through unverified.
      return {
        success: false,
        error:
          'Cannot verify appointment ownership for an S1 caller reschedule (no appointment repo wired) — refusing.',
      };
    }

    if (this.appointmentRepo) {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }

      if (isS1) {
        const jobRepo = this.feasibilityDeps?.jobRepo;
        if (!jobRepo) {
          return {
            success: false,
            error:
              'Cannot verify appointment ownership for an S1 caller reschedule (no job lookup wired) — refusing.',
          };
        }
        const job = await jobRepo.findById(context.tenantId, appointment.jobId);
        if (!job || job.customerId !== callerCustomerId) {
          return {
            success: false,
            error:
              "This appointment does not belong to the caller — an S1 reschedule can only move the caller's own appointment.",
          };
        }
      }

      // Staleness check
      const freshness = checkSchedulingProposalFreshness(proposal, appointment);
      if (!freshness.fresh) {
        return { success: false, error: `Stale proposal: ${freshness.reasons.join('; ')}` };
      }

      // "No slot selected" guard. Tech-out proposals (P6-028) are created with
      // `sourceContext.requiresSlotSelection` and the payload seeded with the
      // appointment's CURRENT times, for the owner to edit to a real new slot.
      // Approving one (e.g. via APPROVE ALL) WITHOUT editing would update
      // nothing yet still fire a customer "we've rescheduled you" notification
      // (notifyRescheduled below). Reject that so the owner must pick a time
      // first. Scoped to flagged proposals so an ordinary reschedule
      // re-executed with its already-applied times stays idempotent.
      const requiresSlotSelection =
        proposal.sourceContext?.requiresSlotSelection === true;
      const hasArrivalWindowChange =
        payload.newArrivalWindowStart != null ||
        payload.newArrivalWindowEnd != null;
      if (
        requiresSlotSelection &&
        !hasArrivalWindowChange &&
        startDate.getTime() === appointment.scheduledStart.getTime() &&
        endDate.getTime() === appointment.scheduledEnd.getTime()
      ) {
        return {
          success: false,
          error:
            'Reschedule has no new time selected — pick a new slot before approving.',
        };
      }

      // Conflict / feasibility check — delegate to the checkFeasibility composer
      let trailingWarnings: FeasibilityIssue[] = [];
      if (this.feasibilityDeps) {
        // Determine the proposed technician — for in-lane reschedule, that's the current primary.
        // Look it up via assignmentRepo if available; otherwise fall back to '' (composer skips overlap).
        let proposedTechnicianId = '';
        if (this.assignmentRepo) {
          const currentAssignments = await this.assignmentRepo.findByAppointment(context.tenantId, appointmentId);
          const primary = currentAssignments.find((a) => a.isPrimary);
          if (primary) proposedTechnicianId = primary.technicianId;
        }

        const feasibility = await checkFeasibility(
          {
            tenantId: context.tenantId,
            appointment,
            proposedTechnicianId,
            proposedScheduledStart: startDate,
            proposedScheduledEnd: endDate,
          },
          this.feasibilityDeps,
        );
        if (feasibility.blocking.length > 0) {
          return {
            success: false,
            error: feasibility.blocking[0].message,
            ...({ warnings: feasibility.warnings } as Record<string, unknown>),
          };
        }
        trailingWarnings = feasibility.warnings;
      }

      const updates: Record<string, unknown> = {
        scheduledStart: startDate,
        scheduledEnd: endDate,
      };

      if (payload.newArrivalWindowStart) {
        updates.arrivalWindowStart = new Date(payload.newArrivalWindowStart as string);
      }
      if (payload.newArrivalWindowEnd) {
        updates.arrivalWindowEnd = new Date(payload.newArrivalWindowEnd as string);
      }

      const updated = await updateAppointment(
        context.tenantId,
        appointmentId,
        updates as any,
        this.appointmentRepo,
      );

      if (!updated) {
        return { success: false, error: 'Failed to update appointment' };
      }

      if (this.analyticsRepo) {
        await captureDispatchEvent(this.analyticsRepo, context.tenantId, 'rescheduled', {
          appointmentId,
          metadata: {
            proposalId: proposal.id,
            newScheduledStart,
            newScheduledEnd,
          },
        });
      }

      // Deliberate: the audit `create` below is a bare `await` with no try/catch.
      // A throw here is intentionally surfaced to the caller — `appointment.rescheduled`
      // is the only audit event for this action, and silently losing it would be
      // worse than failing the execution after the appointment was rescheduled.
      if (this.auditRepo) {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'appointment.rescheduled',
            entityType: 'appointment',
            entityId: appointmentId,
            metadata: {
              proposalId: proposal.id,
              oldScheduledStart: appointment.scheduledStart.toISOString(),
              oldScheduledEnd: appointment.scheduledEnd.toISOString(),
              newScheduledStart,
              newScheduledEnd,
            },
          }),
        );
      }

      if (this.transactionalComms) {
        // The proposal id is the per-ACTION claim token so a later reschedule
        // of the SAME appointment isn't silently suppressed by an earlier
        // one's tombstone. The destination timestamp (newScheduledStart) is
        // NOT safe here: moving to slot B, then elsewhere, then back to B
        // reuses the same appt-reschedule:{id}:B claim, so the final move-back
        // notification would be dropped as a duplicate. Each approved
        // reschedule is a distinct proposal, so proposal.id is unique per
        // occurrence (Codex P2, PR #705).
        await this.transactionalComms.notifyRescheduled(
          context.tenantId,
          appointmentId,
          proposal.id,
        );
      }

      // Spatial board sync. When a reschedule crosses calendar days, BOTH
      // boards must refresh: the new day (appointment appears) and the old
      // day (appointment leaves). Notifying only the new day would leave a
      // stale card on a dispatcher viewing the original day.
      notifyDispatchBoardChanged(context.tenantId, updated.scheduledStart, updated.timezone);
      // Compare the tenant-LOCAL days (not UTC) — a move within the same tenant
      // day that straddles UTC midnight must not spuriously notify a second
      // board, and a cross-tenant-day move that stays within one UTC day must.
      const oldDate = boardDateFromAppointment(appointment.scheduledStart, appointment.timezone);
      const newDate = boardDateFromAppointment(updated.scheduledStart, updated.timezone);
      if (oldDate !== newDate) {
        notifyDispatchBoardChanged(context.tenantId, appointment.scheduledStart, appointment.timezone);
      }

      return {
        success: true,
        resultEntityId: appointmentId,
        ...({ warnings: trailingWarnings } as Record<string, unknown>),
      };
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
