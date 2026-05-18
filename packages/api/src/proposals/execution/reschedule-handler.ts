import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
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

export class RescheduleAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'reschedule_appointment';

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

    if (this.appointmentRepo) {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }

      // Staleness check
      const freshness = checkSchedulingProposalFreshness(proposal, appointment);
      if (!freshness.fresh) {
        return { success: false, error: `Stale proposal: ${freshness.reasons.join('; ')}` };
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
        await this.transactionalComms.notifyRescheduled(context.tenantId, appointmentId);
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
