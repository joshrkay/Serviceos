import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician, unassignTechnician } from '../../appointments/assignment';
import { checkSchedulingProposalFreshness } from '../../ai/guardrails/scheduling-staleness';
import {
  DispatchAnalyticsRepository,
  captureDispatchEvent,
} from '../../dispatch/analytics';
import { checkFeasibility } from '../../scheduling/feasibility';
import { FeasibilityDependencies, FeasibilityIssue } from '../../scheduling/feasibility-types';
import { notifyDispatchBoardChanged } from '../../dispatch/board-notify';
import { AuditRepository } from '../../audit/audit';

export class ReassignAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'reassign_appointment';

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

    const toTechnicianId = payload.toTechnicianId;
    if (!toTechnicianId || typeof toTechnicianId !== 'string') {
      return { success: false, error: 'Payload must include a valid toTechnicianId' };
    }

    let trailingWarnings: FeasibilityIssue[] = [];

    // Validate appointment exists if repo available
    if (this.appointmentRepo) {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }

      // Staleness check — ensure appointment hasn't changed since proposal was created
      if (this.assignmentRepo) {
        const currentAssignments = await this.assignmentRepo.findByAppointment(
          context.tenantId,
          appointmentId,
        );
        const primaryAssignment = currentAssignments.find((a) => a.isPrimary);
        const freshness = checkSchedulingProposalFreshness(
          proposal,
          appointment,
          primaryAssignment?.technicianId ?? null,
        );
        if (!freshness.fresh) {
          return { success: false, error: `Stale proposal: ${freshness.reasons.join('; ')}` };
        }
      }

      // Feasibility gate — delegates to scheduling/feasibility.ts so creation- and
      // execution-time checks are identical. Only `blocking[]` short-circuits.
      if (this.feasibilityDeps) {
        const feasibility = await checkFeasibility(
          {
            tenantId: context.tenantId,
            appointment,
            proposedTechnicianId: toTechnicianId,
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

    // Remove existing assignment if fromTechnicianId specified
    if (this.assignmentRepo) {
      const fromTechnicianId = payload.fromTechnicianId;
      if (fromTechnicianId && typeof fromTechnicianId === 'string') {
        const existingAssignments = await this.assignmentRepo.findByAppointment(
          context.tenantId,
          appointmentId,
        );
        const toRemove = existingAssignments.find((a) => a.technicianId === fromTechnicianId);
        if (toRemove) {
          await unassignTechnician(context.tenantId, toRemove.id, this.assignmentRepo, {
            auditRepo: this.auditRepo,
            actorId: context.executedBy,
            appointmentId,
            technicianId: toRemove.technicianId,
          });
        }
      }

      // Check idempotency — assignment might already exist
      const currentAssignments = await this.assignmentRepo.findByAppointment(
        context.tenantId,
        appointmentId,
      );
      const alreadyAssigned = currentAssignments.find(
        (a) => a.technicianId === toTechnicianId && a.isPrimary,
      );
      if (alreadyAssigned) {
        return {
          success: true,
          resultEntityId: alreadyAssigned.id,
          ...({ warnings: trailingWarnings } as Record<string, unknown>),
        };
      }

      const assignment = await assignTechnician({
        tenantId: context.tenantId,
        appointmentId,
        technicianId: toTechnicianId,
        technicianRole: 'technician',
        isPrimary: true,
        assignedBy: context.executedBy,
      }, this.assignmentRepo, { appointmentRepo: this.appointmentRepo, auditRepo: this.auditRepo });

      if (this.analyticsRepo) {
        await captureDispatchEvent(this.analyticsRepo, context.tenantId, 'reassigned', {
          appointmentId,
          technicianId: toTechnicianId,
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

    // Without repos, just validate payload
    return {
      success: true,
      resultEntityId: uuidv4(),
      ...({ warnings: trailingWarnings } as Record<string, unknown>),
    };
  }
}
