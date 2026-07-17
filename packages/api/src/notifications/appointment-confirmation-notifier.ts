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

export interface AppointmentConfirmationNotifierDeps {
  delivery: MessageDeliveryProvider;
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  dispatchRepo: DispatchRepository;
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
      // §7 / WS1 — the consent + DNC gate is applied centrally by the
      // GatedMessageDelivery wrapper. This notifier is fire-and-forget from the
      // booking flow, so a suppressed send throws inside sendSms and is
      // swallowed here (email path below still runs). Declares customer class +
      // the stored consent flag.
      const idempotencyKey = `appt-confirm:${request.appointmentId}:sms`;
      try {
        const result = await this.deps.delivery.sendSms({
          to: customer.primaryPhone,
          body: smsBody,
          tenantId: request.tenantId,
          idempotencyKey,
          recipientClass: 'customer',
          consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
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
        // Best-effort — confirmation send failure (or gate suppression) must
        // not block scheduling.
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
