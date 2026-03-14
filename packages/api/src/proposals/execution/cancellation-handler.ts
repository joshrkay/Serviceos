import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';

export class CancelAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'cancel_appointment';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const appointmentId = payload.appointmentId;
    if (!appointmentId || typeof appointmentId !== 'string') {
      return { success: false, error: 'Payload must include a valid appointmentId' };
    }

    const reason = payload.reason;
    if (!reason || typeof reason !== 'string') {
      return { success: false, error: 'Payload must include a reason for cancellation' };
    }

    if (this.appointmentRepo) {
      const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
      if (!appointment) {
        return { success: false, error: `Appointment ${appointmentId} not found` };
      }

      // Idempotency: already canceled
      if (appointment.status === 'canceled') {
        return { success: true, resultEntityId: appointmentId };
      }

      // Cannot cancel completed appointments
      if (appointment.status === 'completed') {
        return { success: false, error: 'Cannot cancel a completed appointment' };
      }

      const updated = await updateAppointment(
        context.tenantId,
        appointmentId,
        { status: 'canceled' },
        this.appointmentRepo,
      );

      if (!updated) {
        return { success: false, error: 'Failed to cancel appointment' };
      }

      return { success: true, resultEntityId: appointmentId };
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
