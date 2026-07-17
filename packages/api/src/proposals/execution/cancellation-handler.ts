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
import { notifyDispatchBoardChanged } from '../../dispatch/board-notify';
import { isValidTimezone } from '../../shared/timezone';
import { notifyOwner } from '../../notifications/owner-notifications-instance';
import { resolveAppointmentCustomerName } from '../../notifications/owner-notification-name-resolver';

/**
 * Resolve the customer display name for the owner cancellation push. The
 * cancellation handler isn't wired with a customer/job repo, so the name is
 * optional context the caller may supply; absent, we fall back to a generic,
 * blame-free label rather than leaking an id.
 */
export type CancellationCustomerNameResolver = (
  tenantId: string,
  appointmentId: string,
) => Promise<string | undefined>;

/** Render an appointment start in the tenant timezone, e.g. "Sat, Mar 14, 9:00 AM".
 *  Mirrors the Intl.DateTimeFormat pattern used by sibling execution handlers. */
function formatWhenLabel(start: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimezone(timezone) ? timezone : 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(start);
}

export class CancelAppointmentExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'cancel_appointment';
  // Awaits transactionalComms.notifyCanceled (customer SMS/email) and notifyOwner
  // (owner push) — external network I/O alongside the appointment-cancel DB
  // write. (notifyDispatchBoardChanged is a non-awaited in-process SSE signal and
  // does not count.)
  performsExternalIo = true;

  constructor(
    private readonly appointmentRepo?: AppointmentRepository,
    private readonly analyticsRepo?: DispatchAnalyticsRepository,
    private readonly auditRepo?: AuditRepository,
    private readonly transactionalComms?: TransactionalCommsService,
    private readonly resolveCustomerName?: CancellationCustomerNameResolver,
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

      // U5 — owner "appointment cancelled" push (best-effort). Covers both
      // owner- and portal-initiated cancellations (both reach this handler).
      // The name resolver is optional context; a failure here must never break
      // the cancellation, so it's isolated. notifyOwner is itself failure-safe.
      try {
        const customerName =
          (this.resolveCustomerName
            ? await this.resolveCustomerName(context.tenantId, appointmentId)
            : await resolveAppointmentCustomerName(context.tenantId, appointmentId)) ||
          'A customer';
        await notifyOwner(context.tenantId, 'appointment_cancellation', {
          appointmentId,
          customerName,
          whenLabel: formatWhenLabel(appointment.scheduledStart, appointment.timezone),
        });
      } catch {
        /* owner push is best-effort — never fail a cancellation on it */
      }

      // Spatial board sync: a canceled appointment must vanish from any open
      // dispatch board for that day.
      notifyDispatchBoardChanged(context.tenantId, appointment.scheduledStart, appointment.timezone);

      return { success: true, resultEntityId: appointmentId };
    }

    return { success: true, resultEntityId: appointmentId };
  }
}
