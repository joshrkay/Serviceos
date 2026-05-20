import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { AppointmentRepository, updateAppointment } from '../../appointments/appointment';
import { checkSchedulingProposalFreshness } from '../../ai/guardrails/scheduling-staleness';
import {
  DispatchAnalyticsRepository,
  captureDispatchEvent,
} from '../../dispatch/analytics';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { TransactionalCommsService } from '../../notifications/transactional-comms-service';

export class CancelAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'cancel_appointment';

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly transactionalComms?: TransactionalCommsService,
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

      // Staleness check
      const freshness = checkSchedulingProposalFreshness(proposal, appointment);
      if (!freshness.fresh) {
        return { success: false, error: `Stale proposal: ${freshness.reasons.join('; ')}` };
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

      if (this.analyticsRepo) {
        await captureDispatchEvent(this.analyticsRepo, context.tenantId, 'canceled', {
          appointmentId,
          metadata: { proposalId: proposal.id, reason },
        });
      }

      // Deliberate: the audit `create` below is a bare `await` with no try/catch.
      // A throw here is intentionally surfaced to the caller — `appointment.canceled`
      // is the only audit event for this action, and silently losing it would be
      // worse than failing the execution after the appointment was canceled.
      if (this.auditRepo) {
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: 'system',
            eventType: 'appointment.canceled',
            entityType: 'appointment',
            entityId: appointmentId,
            metadata: { proposalId: proposal.id, reason },
          }),
        );
      }

      if (this.transactionalComms) {
        await this.transactionalComms.notifyCanceled(context.tenantId, appointmentId);
      }

      return { success: true, resultEntityId: appointmentId };
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
