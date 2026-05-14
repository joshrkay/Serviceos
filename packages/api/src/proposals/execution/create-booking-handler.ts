import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Confirms a tentative held appointment when its `create_booking`
 * proposal is approved. The held appointment was created up front by
 * the voice agent (so the slot is reserved on the calendar); this
 * handler just clears the `holdPendingApproval` flag and emits an
 * `appointment.booked` audit event for the customer-communications
 * subsystem to act on.
 *
 * Degrades to a synthetic-id passthrough when no appointmentRepo is
 * wired — consistent with the other in-registry handlers used by
 * in-memory tests that don't exercise the mutation path.
 */
export class CreateBookingExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_booking';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly auditRepo?: AuditRepository,
  ) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;

    const appointmentId = payload.appointmentId;
    if (!appointmentId || typeof appointmentId !== 'string') {
      return { success: false, error: 'Payload must include a valid appointmentId' };
    }

    if (!this.appointmentRepo) {
      return { success: true, resultEntityId: appointmentId };
    }

    const appointment = await this.appointmentRepo.findById(context.tenantId, appointmentId);
    if (!appointment) {
      return { success: false, error: `Appointment ${appointmentId} not found` };
    }

    // Idempotency: a non-held appointment is already confirmed.
    if (!appointment.holdPendingApproval) {
      return { success: true, resultEntityId: appointmentId };
    }

    // A hold that expired before approval cannot be confirmed — its
    // slot was already released back into availability.
    if (appointment.holdExpiryAt && appointment.holdExpiryAt.getTime() < Date.now()) {
      return {
        success: false,
        error: `Hold on appointment ${appointmentId} has expired — re-book the slot`,
      };
    }

    const updated = await updateAppointment(
      context.tenantId,
      appointmentId,
      { holdPendingApproval: false },
      this.appointmentRepo,
    );
    if (!updated) {
      return { success: false, error: 'Failed to confirm held appointment' };
    }

    if (this.auditRepo) {
      await this.auditRepo.create(
        createAuditEvent({
          tenantId: context.tenantId,
          actorId: context.executedBy,
          actorRole: 'system',
          eventType: 'appointment.booked',
          entityType: 'appointment',
          entityId: appointmentId,
          metadata: { proposalId: proposal.id, jobId: appointment.jobId },
        }),
      );
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
