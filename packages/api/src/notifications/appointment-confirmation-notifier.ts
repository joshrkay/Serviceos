import {
  SchedulingConfirmationNotifier,
  SchedulingConfirmationRequest,
} from '../proposals/execution/scheduling-notifications';
import { AppointmentRepository } from '../appointments/appointment';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { SettingsRepository } from '../settings/settings';
import { MessageDeliveryProvider } from './delivery-provider';
import { DispatchRepository } from './dispatch-repository';
import { DncRepository, normalizePhone } from '../compliance/dnc';

export interface AppointmentConfirmationNotifierDeps {
  delivery: MessageDeliveryProvider;
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  dispatchRepo: DispatchRepository;
  /**
   * §7 Phase 1 compliance gate. When set, SMS sends are suppressed if
   * the recipient phone appears on the tenant DNC list. The customer's
   * sms_consent flag is also enforced here.
   */
  dncRepo: DncRepository;
}

function formatAppointmentDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

/**
 * Sends an appointment confirmation SMS/email after a create_appointment
 * proposal executes. Respects the tenant's autoSendAppointmentReminders flag.
 * Failures are best-effort — they do not block the scheduling flow.
 */
export class AppointmentConfirmationNotifier implements SchedulingConfirmationNotifier {
  constructor(private readonly deps: AppointmentConfirmationNotifierDeps) {}

  async enqueue(request: SchedulingConfirmationRequest): Promise<void> {
    const settings = await this.deps.settingsRepo.findByTenant(request.tenantId);
    if (settings?.autoSendAppointmentReminders === false) {
      return;
    }

    const appointment = await this.deps.appointmentRepo.findById(
      request.tenantId,
      request.appointmentId,
    );
    if (!appointment) return;

    const job = await this.deps.jobRepo.findById(request.tenantId, appointment.jobId);
    if (!job) return;

    const customer = await this.deps.customerRepo.findById(request.tenantId, job.customerId);
    if (!customer) return;

    const businessName = settings?.businessName ?? 'Your service team';
    const dateTimeStr = formatAppointmentDate(appointment.scheduledStart, appointment.timezone);

    const smsLines = [
      `Hi ${customer.firstName || customer.displayName}, your appointment with ${businessName} is confirmed.`,
      `Date & time: ${dateTimeStr}`,
    ];
    const smsBody = smsLines.join('\n');

    const channels = request.channels;

    if (channels.includes('sms') && customer.primaryPhone) {
      // §7 phase 1 — best-effort compliance gate (don't throw, just skip).
      // sms_consent must be explicitly true; phone must not be on DNC.
      if (customer.smsConsent !== true) {
        // Skip SMS silently; email path below still runs if requested.
      } else if (await this.deps.dncRepo.isOnDnc(request.tenantId, normalizePhone(customer.primaryPhone))) {
        // Same — suppression is silent here because this notifier is
        // fire-and-forget from the booking flow; failures must not
        // surface to the customer or block the scheduling proposal.
      } else {
      const idempotencyKey = `appt-confirm:${request.appointmentId}:sms`;
      try {
        const result = await this.deps.delivery.sendSms({
          to: customer.primaryPhone,
          body: smsBody,
          tenantId: request.tenantId,
          idempotencyKey,
        });
        await this.deps.dispatchRepo.create({
          tenantId: request.tenantId,
          entityType: 'appointment_confirmation',
          entityId: request.appointmentId,
          channel: 'sms',
          recipient: customer.primaryPhone,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: 'sent',
          idempotencyKey,
        });
      } catch {
        // Best-effort — confirmation send failure must not block scheduling.
      }
      }
    }

    if (channels.includes('email') && customer.email) {
      const idempotencyKey = `appt-confirm:${request.appointmentId}:email`;
      const subject = `Appointment Confirmed — ${businessName}`;
      const html = `<p>${smsLines.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')}</p>`;
      try {
        const result = await this.deps.delivery.sendEmail({
          to: customer.email,
          subject,
          text: smsBody,
          html,
          tenantId: request.tenantId,
          idempotencyKey,
        });
        await this.deps.dispatchRepo.create({
          tenantId: request.tenantId,
          entityType: 'appointment_confirmation',
          entityId: request.appointmentId,
          channel: 'email',
          recipient: customer.email,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: 'sent',
          idempotencyKey,
        });
      } catch {
        // Best-effort.
      }
    }
  }
}
