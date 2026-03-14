import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';
import { AssignmentRepository } from '../../appointments/assignment';
import { validateAppointmentTimes } from '../../appointments/validation';
import { checkSchedulingProposalFreshness } from '../../ai/guardrails/scheduling-staleness';
import { detectOverlappingAppointments } from '../../dispatch/validation';

export class RescheduleAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'reschedule_appointment';

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

      // Conflict check — ensure no overlapping appointments for the assigned technician
      if (this.assignmentRepo) {
        const assignments = await this.assignmentRepo.findByAppointment(
          context.tenantId,
          appointmentId,
        );
        const primary = assignments.find((a) => a.isPrimary);
        if (primary) {
          const techAssignments = await this.assignmentRepo.findByTechnician(
            context.tenantId,
            primary.technicianId,
          );
          const techAppointments = await Promise.all(
            techAssignments.map((a) =>
              this.appointmentRepo!.findById(context.tenantId, a.appointmentId)
            )
          );
          const existingAppts = techAppointments
            .filter((a): a is NonNullable<typeof a> => a !== null)
            .map((a) => ({
              id: a.id,
              technicianId: primary.technicianId,
              scheduledStart: a.scheduledStart,
              scheduledEnd: a.scheduledEnd,
              status: a.status,
            }));
          const conflicts = detectOverlappingAppointments(
            primary.technicianId,
            startDate,
            endDate,
            existingAppts,
            appointmentId,
          );
          const blocking = conflicts.filter((c) => c.severity === 'blocking');
          if (blocking.length > 0) {
            return { success: false, error: blocking[0].message };
          }
        }
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

      return { success: true, resultEntityId: appointmentId };
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
