import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository } from '../../appointments/appointment';
import { AssignmentRepository, assignTechnician, unassignTechnician } from '../../appointments/assignment';

export class ReassignAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'reassign_appointment';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly assignmentRepo?: AssignmentRepository,
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

    // Validate appointment exists if repo available
    if (this.appointmentRepo) {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
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
          await unassignTechnician(context.tenantId, toRemove.id, this.assignmentRepo);
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
        return { success: true, resultEntityId: alreadyAssigned.id };
      }

      const assignment = await assignTechnician({
        tenantId: context.tenantId,
        appointmentId,
        technicianId: toTechnicianId,
        technicianRole: 'technician',
        isPrimary: true,
        assignedBy: context.executedBy,
      }, this.assignmentRepo);

      return { success: true, resultEntityId: assignment.id };
    }

    // Without repos, just validate payload
    return { success: true, resultEntityId: uuidv4() };
  }
}
