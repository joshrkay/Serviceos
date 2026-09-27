/**
 * #1077 / PRD row 3.8 — the confirmation notifier for a boot with NO message
 * delivery provider (`createMessageDeliveryProvider` resolved mode `'none'`:
 * prod/staging without Twilio or SendGrid credentials).
 *
 * Before this existed that boot fell through to the no-op notifier: an
 * approved booking produced no dispatch row, no audit trail and no signal that
 * the customer was never confirmed. This writes one `status: 'failed'`
 * `appointment_confirmation` dispatch row per channel the customer is
 * reachable on, so the omission shows up wherever sends are reviewed.
 *
 * It mirrors the live path's (`TransactionalCommsService.sendAppointmentNotice`)
 * deliberate skips — the owner turned confirmations off, the appointment is
 * gone or canceled, the customer has no contact on that channel — because
 * those are not delivery failures. Best-effort: the booking is already made,
 * so a recording error is swallowed rather than failing the execution.
 */
import type { AppointmentRepository } from '../appointments/appointment';
import type { CustomerRepository } from '../customers/customer';
import type { JobRepository } from '../jobs/job';
import type { SettingsRepository } from '../settings/settings';
import type {
  SchedulingConfirmationNotifier,
  SchedulingConfirmationRequest,
} from '../proposals/execution/scheduling-notifications';
import type { DispatchRepository } from './dispatch-repository';

export const UNDELIVERED_CONFIRMATION_ERROR =
  'No message delivery provider is configured — confirmation not sent';

export interface UndeliveredConfirmationRecorderDeps {
  appointmentRepo: Pick<AppointmentRepository, 'findById'>;
  jobRepo: Pick<JobRepository, 'findById'>;
  customerRepo: Pick<CustomerRepository, 'findById'>;
  dispatchRepo: Pick<DispatchRepository, 'create'>;
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
}

export class UndeliveredConfirmationRecorder implements SchedulingConfirmationNotifier {
  constructor(private readonly deps: UndeliveredConfirmationRecorderDeps) {}

  async enqueue(request: SchedulingConfirmationRequest): Promise<void> {
    try {
      const { tenantId, appointmentId } = request;
      const settings = await this.deps.settingsRepo?.findByTenant(tenantId);
      if (settings?.autoSendAppointmentReminders === false) return;

      const appointment = await this.deps.appointmentRepo.findById(tenantId, appointmentId);
      if (!appointment || appointment.status === 'canceled') return;
      const job = await this.deps.jobRepo.findById(tenantId, appointment.jobId);
      if (!job) return;
      const customer = await this.deps.customerRepo.findById(tenantId, job.customerId);
      if (!customer) return;

      for (const channel of request.channels) {
        const recipient = channel === 'sms' ? customer.primaryPhone : customer.email;
        if (!recipient) continue;
        await this.deps.dispatchRepo.create({
          tenantId,
          entityType: 'appointment_confirmation',
          entityId: appointmentId,
          channel,
          recipient,
          provider: 'none',
          status: 'failed',
          errorMessage: UNDELIVERED_CONFIRMATION_ERROR,
          idempotencyKey: `appointment-confirmation-undelivered:${appointmentId}:${channel}`,
        });
      }
    } catch {
      // Best-effort — the appointment is already booked.
    }
  }
}
