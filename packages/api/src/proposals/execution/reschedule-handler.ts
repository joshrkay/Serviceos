import { v4 as uuidv4 } from 'uuid';
import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';
import { validateAppointmentTimes } from '../../appointments/validation';

export class RescheduleAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'reschedule_appointment';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
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
