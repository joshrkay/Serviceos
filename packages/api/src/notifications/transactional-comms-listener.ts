/**
 * Layer A transactional comms — maps schedule/money audit events to
 * customer-facing SMS/email. Best-effort: failures are logged and
 * swallowed so mutations are never rolled back after commit.
 */
import type { AuditEvent } from '../audit/audit';
import type { AppointmentRepository } from '../appointments/appointment';
import type { JobRepository } from '../jobs/job';
import type { CustomerRepository } from '../customers/customer';
import type { SettingsRepository } from '../settings/settings';
import type { InvoiceRepository } from '../invoices/invoice';
import type { Logger } from '../logging/logger';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import {
  DispatchEntityType,
  DispatchRepository,
} from './dispatch-repository';
import { MessageDeliveryProvider } from './delivery-provider';
import {
  AppointmentConfirmationNotifier,
} from './appointment-confirmation-notifier';
import {
  renderAppointmentReminderSms,
  renderCancellationSms,
  renderOverdueNudgeSms,
  renderPaymentReceiptSms,
  renderRescheduleSms,
} from './templates';

export interface TransactionalCommsListenerDeps {
  delivery: MessageDeliveryProvider;
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  dispatchRepo: DispatchRepository;
  dncRepo: DncRepository;
  invoiceRepo: InvoiceRepository;
  confirmationNotifier: AppointmentConfirmationNotifier;
  publicBaseUrl: string;
  logger?: Logger;
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

export class TransactionalCommsListener {
  constructor(private readonly deps: TransactionalCommsListenerDeps) {}

  /**
   * Fire-and-forget wrapper — never throws to callers.
   */
  async handleAuditEventSafe(event: AuditEvent): Promise<void> {
    try {
      await this.handleAuditEvent(event);
    } catch (err) {
      this.deps.logger?.warn('Transactional comms listener failed', {
        eventType: event.eventType,
        entityId: event.entityId,
        tenantId: event.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async handleAuditEvent(event: AuditEvent): Promise<void> {
    switch (event.eventType) {
      case 'appointment.booked':
        await this.handleAppointmentBooked(event);
        break;
      case 'appointment.rescheduled':
        await this.handleAppointmentRescheduled(event);
        break;
      case 'appointment.canceled':
        await this.handleAppointmentCanceled(event);
        break;
      case 'payment.recorded':
        await this.handlePaymentRecorded(event);
        break;
      case 'invoice.overdue':
        await this.handleInvoiceOverdue(event);
        break;
      default:
        break;
    }
  }

  /**
   * T−24h reminder — invoked by the appointment-reminder worker, not
   * from an audit event.
   */
  async sendAppointmentReminder(
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    if (settings?.autoSendAppointmentReminders === false) {
      return;
    }

    const idempotencyKey = `appt-reminder-24h:${appointmentId}`;
    if (await this.deps.dispatchRepo.findByIdempotencyKey(tenantId, idempotencyKey)) {
      return;
    }

    const ctx = await this.resolveSchedulingContext(tenantId, appointmentId);
    if (!ctx) return;

    const sms = renderAppointmentReminderSms({
      customerName: ctx.customerName,
      businessName: ctx.businessName,
      dateTimeStr: ctx.dateTimeStr,
    });

    await this.sendSmsIfAllowed({
      tenantId,
      entityType: 'appointment_reminder',
      entityId: appointmentId,
      phone: ctx.phone,
      smsConsent: ctx.smsConsent,
      body: sms.body,
      idempotencyKey,
    });
  }

  private async handleAppointmentBooked(event: AuditEvent): Promise<void> {
    const appointmentId = event.entityId;
    await this.deps.confirmationNotifier.enqueue({
      tenantId: event.tenantId,
      appointmentId,
      jobId: typeof event.metadata?.jobId === 'string' ? event.metadata.jobId : appointmentId,
      channels: ['sms', 'email'],
    });
  }

  private async handleAppointmentRescheduled(event: AuditEvent): Promise<void> {
    const settings = await this.deps.settingsRepo.findByTenant(event.tenantId);
    if (settings?.autoSendAppointmentReminders === false) {
      return;
    }

    const appointmentId = event.entityId;
    const version =
      typeof event.metadata?.newScheduledStart === 'string'
        ? event.metadata.newScheduledStart
        : event.id;
    const idempotencyKey = `appt-reschedule:${appointmentId}:${version}`;
    if (await this.deps.dispatchRepo.findByIdempotencyKey(event.tenantId, idempotencyKey)) {
      return;
    }

    const ctx = await this.resolveSchedulingContext(event.tenantId, appointmentId);
    if (!ctx) return;

    const sms = renderRescheduleSms({
      customerName: ctx.customerName,
      businessName: ctx.businessName,
      dateTimeStr: ctx.dateTimeStr,
    });

    await this.sendSmsIfAllowed({
      tenantId: event.tenantId,
      entityType: 'appointment_reschedule',
      entityId: appointmentId,
      phone: ctx.phone,
      smsConsent: ctx.smsConsent,
      body: sms.body,
      idempotencyKey,
    });
  }

  private async handleAppointmentCanceled(event: AuditEvent): Promise<void> {
    const settings = await this.deps.settingsRepo.findByTenant(event.tenantId);
    if (settings?.autoSendAppointmentReminders === false) {
      return;
    }

    const appointmentId = event.entityId;
    const idempotencyKey = `appt-cancel:${appointmentId}`;
    if (await this.deps.dispatchRepo.findByIdempotencyKey(event.tenantId, idempotencyKey)) {
      return;
    }

    const ctx = await this.resolveSchedulingContext(event.tenantId, appointmentId);
    if (!ctx) return;

    const reason =
      typeof event.metadata?.reason === 'string' ? event.metadata.reason : undefined;
    const sms = renderCancellationSms({
      customerName: ctx.customerName,
      businessName: ctx.businessName,
      dateTimeStr: ctx.dateTimeStr,
      reason,
    });

    await this.sendSmsIfAllowed({
      tenantId: event.tenantId,
      entityType: 'appointment_cancel',
      entityId: appointmentId,
      phone: ctx.phone,
      smsConsent: ctx.smsConsent,
      body: sms.body,
      idempotencyKey,
    });
  }

  private async handlePaymentRecorded(event: AuditEvent): Promise<void> {
    const invoiceId = event.entityId;
    const paymentId =
      typeof event.metadata?.paymentId === 'string' ? event.metadata.paymentId : event.id;
    const amountCents =
      typeof event.metadata?.amountCents === 'number' ? event.metadata.amountCents : 0;

    const idempotencyKey = `payment-receipt:${paymentId}`;
    if (await this.deps.dispatchRepo.findByIdempotencyKey(event.tenantId, idempotencyKey)) {
      return;
    }

    const invoice = await this.deps.invoiceRepo.findById(event.tenantId, invoiceId);
    if (!invoice) return;

    const job = await this.deps.jobRepo.findById(event.tenantId, invoice.jobId);
    if (!job) return;

    const customer = await this.deps.customerRepo.findById(event.tenantId, job.customerId);
    if (!customer) return;

    const settings = await this.deps.settingsRepo.findByTenant(event.tenantId);
    const businessName = settings?.businessName ?? 'Your service team';
    const viewUrl = invoice.viewToken
      ? `${this.deps.publicBaseUrl.replace(/\/$/, '')}/pay/${invoice.viewToken}`
      : undefined;

    const sms = renderPaymentReceiptSms({
      customerName: customer.firstName || customer.displayName || 'there',
      businessName,
      invoiceNumber: invoice.invoiceNumber,
      amountCents,
      viewUrl,
    });

    await this.sendSmsIfAllowed({
      tenantId: event.tenantId,
      entityType: 'payment_receipt',
      entityId: paymentId,
      phone: customer.primaryPhone,
      smsConsent: customer.smsConsent,
      body: sms.body,
      idempotencyKey,
    });
  }

  private async handleInvoiceOverdue(event: AuditEvent): Promise<void> {
    const invoiceId = event.entityId;
    const idempotencyKey = `invoice-overdue:${invoiceId}:first`;
    if (await this.deps.dispatchRepo.findByIdempotencyKey(event.tenantId, idempotencyKey)) {
      return;
    }

    const invoice = await this.deps.invoiceRepo.findById(event.tenantId, invoiceId);
    if (!invoice) return;

    const job = await this.deps.jobRepo.findById(event.tenantId, invoice.jobId);
    if (!job) return;

    const customer = await this.deps.customerRepo.findById(event.tenantId, job.customerId);
    if (!customer) return;

    const settings = await this.deps.settingsRepo.findByTenant(event.tenantId);
    const businessName = settings?.businessName ?? 'Your service team';
    const viewUrl = invoice.viewToken
      ? `${this.deps.publicBaseUrl.replace(/\/$/, '')}/pay/${invoice.viewToken}`
      : undefined;

    const sms = renderOverdueNudgeSms({
      customerName: customer.firstName || customer.displayName || 'there',
      businessName,
      invoiceNumber: invoice.invoiceNumber,
      amountDueCents: invoice.amountDueCents,
      dueDateIso: invoice.dueDate?.toISOString(),
      viewUrl,
    });

    await this.sendSmsIfAllowed({
      tenantId: event.tenantId,
      entityType: 'invoice_overdue_nudge',
      entityId: invoiceId,
      phone: customer.primaryPhone,
      smsConsent: customer.smsConsent,
      body: sms.body,
      idempotencyKey,
    });
  }

  private async resolveSchedulingContext(
    tenantId: string,
    appointmentId: string,
  ): Promise<{
    customerName: string;
    businessName: string;
    dateTimeStr: string;
    phone?: string;
    smsConsent?: boolean;
  } | null> {
    const appointment = await this.deps.appointmentRepo.findById(tenantId, appointmentId);
    if (!appointment) return null;

    const job = await this.deps.jobRepo.findById(tenantId, appointment.jobId);
    if (!job) return null;

    const customer = await this.deps.customerRepo.findById(tenantId, job.customerId);
    if (!customer) return null;

    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    const businessName = settings?.businessName ?? 'Your service team';

    return {
      customerName: customer.firstName || customer.displayName || 'there',
      businessName,
      dateTimeStr: formatAppointmentDate(appointment.scheduledStart, appointment.timezone),
      phone: customer.primaryPhone,
      smsConsent: customer.smsConsent,
    };
  }

  private async sendSmsIfAllowed(input: {
    tenantId: string;
    entityType: DispatchEntityType;
    entityId: string;
    phone?: string;
    smsConsent?: boolean;
    body: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (!input.phone) return;
    if (input.smsConsent !== true) return;
    if (await this.deps.dncRepo.isOnDnc(input.tenantId, normalizePhone(input.phone))) {
      return;
    }

    try {
      const result = await this.deps.delivery.sendSms({
        to: input.phone,
        body: input.body,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
      });
      await this.deps.dispatchRepo.create({
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel: 'sms',
        recipient: input.phone,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey: input.idempotencyKey,
      });
    } catch {
      // Best-effort — do not propagate.
    }
  }
}
