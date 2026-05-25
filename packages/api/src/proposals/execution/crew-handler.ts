import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician, unassignTechnician } from '../../appointments/assignment';
import { DispatchAnalyticsRepository, captureDispatchEvent } from '../../dispatch/analytics';
import { checkFeasibility } from '../../scheduling/feasibility';
import { FeasibilityDependencies, FeasibilityIssue } from '../../scheduling/feasibility-types';
import { notifyDispatchBoardChanged } from '../../dispatch/board-notify';
import { AuditRepository } from '../../audit/audit';

/**
 * Attaches an additional (non-primary) technician to an appointment so a
 * job can be crewed by 2+ tradespeople. The primary assignment is left
 * untouched — `assignTechnician` only demotes existing primaries when the
 * new assignment is itself primary, so passing `isPrimary: false` is safe.
 */
export class AddCrewMemberExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'add_crew_member';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly feasibilityDeps?: FeasibilityDependencies,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const appointmentId = payload.appointmentId;
    if (!appointmentId || typeof appointmentId !== 'string') {
      return { success: false, error: 'Payload must include a valid appointmentId' };
    }
    const technicianId = payload.technicianId;
    if (!technicianId || typeof technicianId !== 'string') {
      return { success: false, error: 'Payload must include a valid technicianId' };
    }

    let trailingWarnings: FeasibilityIssue[] = [];

    if (this.appointmentRepo) {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }

      // Feasibility gate for the crew member's own calendar — identical to
      // the reassignment path so creation- and execution-time checks agree.
      if (this.feasibilityDeps) {
        const feasibility = await checkFeasibility(
          {
            tenantId: context.tenantId,
            appointment,
            proposedTechnicianId: technicianId,
            proposedScheduledStart: appointment.scheduledStart,
            proposedScheduledEnd: appointment.scheduledEnd,
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
    }

    if (this.assignmentRepo) {
      const existing = await this.assignmentRepo.findByAppointment(context.tenantId, appointmentId);
      const alreadyAssigned = existing.find((a) => a.technicianId === technicianId);
      if (alreadyAssigned) {
        // Tech is already on this appointment (primary or crew). Idempotent —
        // do not demote a primary into a crew slot.
        return {
          success: true,
          resultEntityId: alreadyAssigned.id,
          ...({ warnings: trailingWarnings } as Record<string, unknown>),
        };
      }

      const assignment = await assignTechnician({
        tenantId: context.tenantId,
        appointmentId,
        technicianId,
        technicianRole: 'technician',
        isPrimary: false,
        assignedBy: context.executedBy,
      }, this.assignmentRepo, { appointmentRepo: this.appointmentRepo, auditRepo: this.auditRepo });

      if (this.analyticsRepo) {
        await captureDispatchEvent(this.analyticsRepo, context.tenantId, 'crew_added', {
          appointmentId,
          technicianId,
          metadata: { proposalId: proposal.id },
        });
      }

      if (this.appointmentRepo) {
        const appt = await this.appointmentRepo.findById(context.tenantId, appointmentId);
        if (appt) notifyDispatchBoardChanged(context.tenantId, appt.scheduledStart);
      }

      return {
        success: true,
        resultEntityId: assignment.id,
        ...({ warnings: trailingWarnings } as Record<string, unknown>),
      };
    }

    return {
      success: true,
      resultEntityId: uuidv4(),
      ...({ warnings: trailingWarnings } as Record<string, unknown>),
    };
  }
}

/**
 * Detaches a non-primary (crew) technician from an appointment. Refuses to
 * remove the primary assignment — changing the primary goes through the
 * reassignment flow so the lane and `job.assignedTechnicianId` stay in sync.
 */
export class RemoveCrewMemberExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'remove_crew_member';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const appointmentId = payload.appointmentId;
    if (!appointmentId || typeof appointmentId !== 'string') {
      return { success: false, error: 'Payload must include a valid appointmentId' };
    }
    const technicianId = payload.technicianId;
    if (!technicianId || typeof technicianId !== 'string') {
      return { success: false, error: 'Payload must include a valid technicianId' };
    }

    if (!this.assignmentRepo) {
      return { success: true, resultEntityId: uuidv4() };
    }

    const existing = await this.assignmentRepo.findByAppointment(context.tenantId, appointmentId);
    const match = existing.find((a) => a.technicianId === technicianId);

    if (!match) {
      // Already absent — idempotent success.
      return { success: true, resultEntityId: appointmentId };
    }
    if (match.isPrimary) {
      return {
        success: false,
        error: 'Cannot remove the primary technician via crew removal — use reassignment',
      };
    }

    await unassignTechnician(context.tenantId, match.id, this.assignmentRepo, {
      auditRepo: this.auditRepo,
      actorId: context.executedBy,
      appointmentId,
      technicianId: match.technicianId,
    });

    if (this.analyticsRepo) {
      await captureDispatchEvent(this.analyticsRepo, context.tenantId, 'crew_removed', {
        appointmentId,
        technicianId,
        metadata: { proposalId: proposal.id },
      });
    }

    if (this.appointmentRepo) {
      const appt = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (appt) notifyDispatchBoardChanged(context.tenantId, appt.scheduledStart);
    }

    return { success: true, resultEntityId: match.id };
  }
}
