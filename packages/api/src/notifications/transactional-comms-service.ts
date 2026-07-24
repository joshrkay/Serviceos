import { AppointmentRepository } from '../appointments/appointment';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { SettingsRepository } from '../settings/settings';
import { InvoiceRepository } from '../invoices/invoice';
import {
  SchedulingConfirmationNotifier,
  SchedulingConfirmationRequest,
} from '../proposals/execution/scheduling-notifications';
import {
  sendCustomerMessage,
  CustomerMessageDeliveryDeps,
  CustomerMessageChannel,
} from './customer-message-delivery';
import {
  renderAppointmentConfirmationSms,
  renderAppointmentRescheduleSms,
  renderAppointmentCancelSms,
  renderAppointmentReminderSms,
  renderPaymentReceiptSms,
  renderInvoiceOverdueSms,
} from './templates';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { tn } from './i18n';
import type { Language } from '../ai/i18n/i18n';

export interface TransactionalCommsServiceDeps extends CustomerMessageDeliveryDeps {
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  invoiceRepo: InvoiceRepository;
}

function formatAppointmentDate(date: Date, timezone: string, language: Language = 'en'): string {
  // Match the notification copy's language so a Spanish notice doesn't carry
  // English weekday/month names.
  const locale = language === 'es' ? 'es-US' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

function customerDisplayName(customer: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}): string {
  return (
    customer.displayName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
    'there'
  );
}

/**
 * Layer A transactional customer communications — booking confirmation,
 * reschedule/cancel notices, T-24h reminders, payment receipts, overdue nudges.
 */
export class TransactionalCommsService implements SchedulingConfirmationNotifier {
  constructor(private readonly deps: TransactionalCommsServiceDeps) {}

  async enqueue(request: SchedulingConfirmationRequest): Promise<void> {
    await this.sendAppointmentNotice(
      request.tenantId,
      request.appointmentId,
      'appointment_confirmation',
      `appt-confirm:${request.appointmentId}`,
      renderAppointmentConfirmationSms,
    );
  }

  /**
   * Codex P1 #1 follow-up — an appointment can legitimately be rescheduled
   * more than once over its lifetime (same `appointmentId` each time), so an
   * `appointmentId`-only claim key would tombstone this notice after the
   * FIRST reschedule and silently suppress it on every later one.
   * `occurrenceToken` makes the claim key per-occurrence. Callers must pass a
   * token unique to each reschedule ACTION — the reschedule handler passes the
   * approving `proposal.id`. The destination `scheduledStart` is NOT safe: an
   * appointment moved to slot B, then elsewhere, then back to B would reuse the
   * same `appt-reschedule:{id}:B` claim and drop the final notification as a
   * duplicate (Codex P2, PR #705).
   */
  async notifyRescheduled(
    tenantId: string,
    appointmentId: string,
    occurrenceToken: string,
  ): Promise<void> {
    await this.sendAppointmentNotice(
      tenantId,
      appointmentId,
      'appointment_reschedule',
      `appt-reschedule:${appointmentId}:${occurrenceToken}`,
      renderAppointmentRescheduleSms,
    );
  }

  async notifyCanceled(tenantId: string, appointmentId: string): Promise<void> {
    await this.sendAppointmentNotice(
      tenantId,
      appointmentId,
      'appointment_cancel',
      `appt-cancel:${appointmentId}`,
      renderAppointmentCancelSms,
    );
  }

  /**
   * Send the T-minus reminder for one appointment.
   *
   * Story 10.2 — when `offsetHours` is provided (tenant configured MULTIPLE
   * reminder offsets), the dispatch idempotency key is scoped per offset so
   * each configured reminder (e.g. 24h and 2h out) fires exactly once. When
   * omitted (the single-offset / legacy default), behavior is unchanged: any
   * prior reminder dispatch suppresses a resend.
   */
  async notifyReminder(
    tenantId: string,
    appointmentId: string,
    offsetHours?: number,
  ): Promise<void> {
    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    if (settings?.autoSendAppointmentReminders === false) {
      return;
    }
    const prefix =
      offsetHours != null
        ? `appt-reminder:${appointmentId}:${offsetHours}h`
        : `appt-reminder:${appointmentId}`;
    const prior = await this.deps.dispatchRepo.findByEntity(
      tenantId,
      'appointment_reminder',
      appointmentId,
    );
    if (offsetHours == null) {
      // Legacy single-reminder dedup: any prior reminder dispatch blocks.
      if (prior.length > 0) return;
    } else {
      // Per-offset dedup: only this offset's reminder blocks a resend.
      const offsetKeys = [`${prefix}:sms`, `${prefix}:email`];
      if (prior.some((d) => d.idempotencyKey != null && offsetKeys.includes(d.idempotencyKey))) {
        return;
      }
    }
    await this.sendAppointmentNotice(
      tenantId,
      appointmentId,
      'appointment_reminder',
      prefix,
      renderAppointmentReminderSms,
    );
  }

  /**
   * Codex P1 #1 — `paymentId` makes the claim key per-OCCURRENCE
   * (`payment-receipt:{invoiceId}:{paymentId}`), not per-invoice. An
   * invoice-scoped-only key would permanently tombstone this entity/prefix
   * pair after the FIRST payment, silently suppressing the receipt for a
   * second (or third) partial payment on the same invoice — a legitimate,
   * recurring send, not a duplicate.
   */
  async notifyPaymentReceived(
    tenantId: string,
    invoiceId: string,
    amountCents: number,
    paymentId: string,
  ): Promise<void> {
    const invoice = await this.deps.invoiceRepo.findById(tenantId, invoiceId);
    if (!invoice) return;

    const job = await this.deps.jobRepo.findById(tenantId, invoice.jobId);
    if (!job) return;

    const customer = await this.deps.customerRepo.findById(tenantId, job.customerId);
    if (!customer) return;

    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    const businessName = settings?.businessName ?? 'Your service team';
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage: settings?.defaultLanguage,
    });
    const sms = renderPaymentReceiptSms({
      customerName: customerDisplayName(customer),
      businessName,
      invoiceNumber: invoice.invoiceNumber,
      amountCents,
      language,
    });

    await sendCustomerMessage(this.deps, {
      tenantId,
      customer,
      entityType: 'payment_receipt',
      entityId: invoiceId,
      channels: ['sms', 'email'],
      smsBody: sms.body,
      emailSubject: tn('email.payment_receipt.subject', language, { business: businessName }),
      emailText: sms.body,
      idempotencyKeyPrefix: `payment-receipt:${invoiceId}:${paymentId}`,
    });
  }

  /**
   * Codex P1 #1 — `occurrenceToken` makes the claim key per dunning-cadence
   * step (`invoice-overdue:{invoiceId}:{occurrenceToken}`), not per-invoice.
   * An invoice-scoped-only key would permanently tombstone this entity/prefix
   * pair after the FIRST reminder, silently suppressing every later step of
   * the collections cadence (send-payment-reminder-handler.ts legitimately
   * permits a next reminder after a 72h cooldown) — a series of deliberately
   * repeatable sends, not duplicates. Callers should pass a token that is
   * stable for a given occurrence and distinct across occurrences — e.g. the
   * dunning ledger's `stepKey` (`'<offsetDays>:<channel>'`, see
   * invoices/dunning-config.ts's `reminderStepKey`) for a cadence step, or
   * `'manual'` for an owner-initiated one-off reminder.
   */
  async notifyInvoiceOverdue(
    tenantId: string,
    invoiceId: string,
    occurrenceToken: string,
  ): Promise<void> {
    const invoice = await this.deps.invoiceRepo.findById(tenantId, invoiceId);
    if (!invoice) return;

    // RIVET invariant I10 — send-time state re-evaluation. An overdue reminder
    // is scheduled/raised against the state at sweep time, but payment can land
    // in the interim (the customer pays, or a webhook reconciles). Re-check the
    // live invoice here, at the moment of firing: a paid or zero-balance
    // invoice must NEVER receive a payment reminder. "The contractor's customer
    // is being dunned for money they already sent" costs more trust than an
    // outage. This closes the payment-lands-between-raise-and-fire race for
    // both the automated dunning sweep and an owner-approved reminder proposal.
    if (invoice.status === 'paid' || invoice.status === 'void') return;
    if (typeof invoice.amountDueCents === 'number' && invoice.amountDueCents <= 0) return;

    const job = await this.deps.jobRepo.findById(tenantId, invoice.jobId);
    if (!job) return;

    const customer = await this.deps.customerRepo.findById(tenantId, job.customerId);
    if (!customer) return;

    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    const businessName = settings?.businessName ?? 'Your service team';
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage: settings?.defaultLanguage,
    });
    const sms = renderInvoiceOverdueSms({
      customerName: customerDisplayName(customer),
      businessName,
      invoiceNumber: invoice.invoiceNumber,
      amountDueCents: invoice.amountDueCents,
      dueDateIso: invoice.dueDate?.toISOString(),
      language,
    });

    await sendCustomerMessage(this.deps, {
      tenantId,
      customer,
      entityType: 'invoice_overdue',
      entityId: invoiceId,
      channels: ['sms', 'email'],
      smsBody: sms.body,
      emailSubject: tn('email.invoice_overdue.subject', language, { business: businessName }),
      emailText: sms.body,
      idempotencyKeyPrefix: `invoice-overdue:${invoiceId}:${occurrenceToken}`,
    });
  }

  private async sendAppointmentNotice(
    tenantId: string,
    appointmentId: string,
    entityType:
      | 'appointment_confirmation'
      | 'appointment_reschedule'
      | 'appointment_cancel'
      | 'appointment_reminder',
    idempotencyKeyPrefix: string,
    renderSms: (ctx: {
      customerName: string;
      businessName: string;
      dateTimeStr: string;
      language?: Language;
    }) => { body: string },
  ): Promise<void> {
    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    if (
      (entityType === 'appointment_confirmation' ||
        entityType === 'appointment_reminder') &&
      settings?.autoSendAppointmentReminders === false
    ) {
      return;
    }

    const appointment = await this.deps.appointmentRepo.findById(tenantId, appointmentId);
    if (!appointment || appointment.status === 'canceled') return;

    const job = await this.deps.jobRepo.findById(tenantId, appointment.jobId);
    if (!job) return;

    const customer = await this.deps.customerRepo.findById(tenantId, job.customerId);
    if (!customer) return;

    const businessName = settings?.businessName ?? 'Your service team';
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage: settings?.defaultLanguage,
    });
    const dateTimeStr = formatAppointmentDate(
      appointment.scheduledStart,
      appointment.timezone,
      language,
    );
    const sms = renderSms({
      customerName: customerDisplayName(customer),
      businessName,
      dateTimeStr,
      language,
    });

    const channels: CustomerMessageChannel[] = ['sms', 'email'];
    await sendCustomerMessage(this.deps, {
      tenantId,
      customer,
      entityType,
      entityId: appointmentId,
      channels,
      smsBody: sms.body,
      emailSubject: tn('email.appointment.subject', language, { business: businessName }),
      emailText: sms.body,
      idempotencyKeyPrefix,
    });
  }
}
