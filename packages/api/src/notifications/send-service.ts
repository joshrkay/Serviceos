import { randomBytes } from 'crypto';
import { CustomerRepository } from '../customers/customer';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository } from '../invoices/invoice';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { ValidationError, NotFoundError } from '../shared/errors';
import { DispatchRepository } from './dispatch-repository';
import {
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from './delivery-provider';
import {
  renderEstimateEmail,
  renderEstimateSms,
  renderInvoiceEmail,
  renderInvoiceSms,
} from './templates';

export type SendChannel = 'sms' | 'email' | 'both';

export interface SendEstimateInput {
  tenantId: string;
  estimateId: string;
  channel: SendChannel;
  /** Override recipient. Defaults to customer's preferred channel value. */
  recipientPhone?: string;
  recipientEmail?: string;
  customMessage?: string;
}

export interface SendInvoiceInput {
  tenantId: string;
  invoiceId: string;
  channel: SendChannel;
  recipientPhone?: string;
  recipientEmail?: string;
  customMessage?: string;
}

export interface SendResult {
  estimateId?: string;
  invoiceId?: string;
  viewUrl: string;
  viewToken: string;
  channelsSent: Array<{
    channel: 'sms' | 'email';
    recipient: string;
    provider: string;
    providerMessageId: string;
    dispatchId: string;
  }>;
}

export interface SendServiceDeps {
  delivery: MessageDeliveryProvider;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  dispatchRepo: DispatchRepository;
  publicBaseUrl: string;
}

/**
 * The send service is the single place where customer-facing messages
 * for estimates and invoices are dispatched. Routes call into here
 * rather than touching the delivery provider directly so we have one
 * place to enforce:
 *
 *   1. View-token generation and persistence on the entity
 *   2. Recipient resolution (customer record → phone/email)
 *   3. Template rendering with consistent business name and link
 *   4. Dispatch row creation (audit trail of every send)
 *   5. Status transition (estimate.status → 'sent', invoice.sent_at)
 *
 * Failures in any one channel don't abort the other — if SMS fails
 * but email succeeds, we record both outcomes and surface a partial
 * success to the caller.
 */
export class SendService {
  constructor(private readonly deps: SendServiceDeps) {}

  async sendEstimate(input: SendEstimateInput): Promise<SendResult> {
    const estimate = await this.deps.estimateRepo.findById(
      input.tenantId,
      input.estimateId
    );
    if (!estimate) {
      throw new NotFoundError('Estimate', input.estimateId);
    }

    const job = await this.deps.jobRepo.findById(input.tenantId, estimate.jobId);
    if (!job) {
      throw new NotFoundError('Job', estimate.jobId);
    }

    const customer = await this.deps.customerRepo.findById(
      input.tenantId,
      job.customerId
    );
    if (!customer) {
      throw new NotFoundError('Customer', job.customerId);
    }

    const businessName = await this.resolveBusinessName(input.tenantId);
    const viewToken = estimate.viewToken ?? generateViewToken();
    const viewUrl = this.buildViewUrl('e', viewToken);

    const channels = resolveChannels({
      channel: input.channel,
      customer,
      recipientPhone: input.recipientPhone,
      recipientEmail: input.recipientEmail,
    });

    const sent: SendResult['channelsSent'] = [];
    const errors: string[] = [];

    for (const target of channels) {
      try {
        const dispatchId = await this.dispatchOne({
          tenantId: input.tenantId,
          entityType: 'estimate',
          entityId: estimate.id,
          target,
          render: () =>
            target.channel === 'sms'
              ? this.renderEstimateSmsMessage(target.recipient, {
                  customerName: customer.displayName,
                  estimateNumber: estimate.estimateNumber,
                  totalCents: estimate.totals.totalCents,
                  businessName,
                  viewUrl,
                  customMessage: input.customMessage,
                })
              : this.renderEstimateEmailMessage(target.recipient, {
                  customerName: customer.displayName,
                  estimateNumber: estimate.estimateNumber,
                  totalCents: estimate.totals.totalCents,
                  businessName,
                  viewUrl,
                  customMessage: input.customMessage,
                }),
        });
        sent.push(dispatchId);
      } catch (err) {
        errors.push(
          `${target.channel} to ${target.recipient}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`
        );
      }
    }

    if (sent.length === 0) {
      throw new ValidationError(
        `Estimate send failed on all channels: ${errors.join('; ')}`
      );
    }

    const now = new Date();
    await this.deps.estimateRepo.update(input.tenantId, estimate.id, {
      viewToken,
      sentAt: now,
      lastDispatchId: sent[sent.length - 1].dispatchId,
      status: estimate.status === 'draft' || estimate.status === 'ready_for_review'
        ? 'sent'
        : estimate.status,
      updatedAt: now,
    });

    return {
      estimateId: estimate.id,
      viewUrl,
      viewToken,
      channelsSent: sent,
    };
  }

  async sendInvoice(input: SendInvoiceInput): Promise<SendResult> {
    const invoice = await this.deps.invoiceRepo.findById(
      input.tenantId,
      input.invoiceId
    );
    if (!invoice) {
      throw new NotFoundError('Invoice', input.invoiceId);
    }

    const job = await this.deps.jobRepo.findById(input.tenantId, invoice.jobId);
    if (!job) {
      throw new NotFoundError('Job', invoice.jobId);
    }

    const customer = await this.deps.customerRepo.findById(
      input.tenantId,
      job.customerId
    );
    if (!customer) {
      throw new NotFoundError('Customer', job.customerId);
    }

    const businessName = await this.resolveBusinessName(input.tenantId);
    const viewToken = invoice.viewToken ?? generateViewToken();
    const viewUrl = this.buildViewUrl('pay', viewToken);

    const channels = resolveChannels({
      channel: input.channel,
      customer,
      recipientPhone: input.recipientPhone,
      recipientEmail: input.recipientEmail,
    });

    const sent: SendResult['channelsSent'] = [];
    const errors: string[] = [];

    for (const target of channels) {
      try {
        const dispatchId = await this.dispatchOne({
          tenantId: input.tenantId,
          entityType: 'invoice',
          entityId: invoice.id,
          target,
          render: () =>
            target.channel === 'sms'
              ? this.renderInvoiceSmsMessage(target.recipient, {
                  customerName: customer.displayName,
                  invoiceNumber: invoice.invoiceNumber,
                  totalCents: invoice.totals.totalCents,
                  businessName,
                  viewUrl,
                  dueDateIso: invoice.dueDate?.toISOString(),
                  customMessage: input.customMessage,
                })
              : this.renderInvoiceEmailMessage(target.recipient, {
                  customerName: customer.displayName,
                  invoiceNumber: invoice.invoiceNumber,
                  totalCents: invoice.totals.totalCents,
                  businessName,
                  viewUrl,
                  dueDateIso: invoice.dueDate?.toISOString(),
                  customMessage: input.customMessage,
                }),
        });
        sent.push(dispatchId);
      } catch (err) {
        errors.push(
          `${target.channel} to ${target.recipient}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`
        );
      }
    }

    if (sent.length === 0) {
      throw new ValidationError(
        `Invoice send failed on all channels: ${errors.join('; ')}`
      );
    }

    const now = new Date();
    await this.deps.invoiceRepo.update(input.tenantId, invoice.id, {
      viewToken,
      sentAt: now,
      lastDispatchId: sent[sent.length - 1].dispatchId,
      updatedAt: now,
    });

    return {
      invoiceId: invoice.id,
      viewUrl,
      viewToken,
      channelsSent: sent,
    };
  }

  private async resolveBusinessName(tenantId: string): Promise<string> {
    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    return settings?.businessName ?? 'Your service team';
  }

  private buildViewUrl(prefix: 'e' | 'pay', token: string): string {
    const base = this.deps.publicBaseUrl.replace(/\/$/, '');
    return `${base}/${prefix}/${token}`;
  }

  private renderEstimateSmsMessage(
    to: string,
    ctx: Parameters<typeof renderEstimateSms>[0]
  ): SmsMessage {
    const { body } = renderEstimateSms(ctx);
    return { to, body };
  }

  private renderEstimateEmailMessage(
    to: string,
    ctx: Parameters<typeof renderEstimateEmail>[0]
  ): EmailMessage {
    const { subject, text, html } = renderEstimateEmail(ctx);
    return { to, subject, text, html };
  }

  private renderInvoiceSmsMessage(
    to: string,
    ctx: Parameters<typeof renderInvoiceSms>[0]
  ): SmsMessage {
    const { body } = renderInvoiceSms(ctx);
    return { to, body };
  }

  private renderInvoiceEmailMessage(
    to: string,
    ctx: Parameters<typeof renderInvoiceEmail>[0]
  ): EmailMessage {
    const { subject, text, html } = renderInvoiceEmail(ctx);
    return { to, subject, text, html };
  }

  private async dispatchOne(args: {
    tenantId: string;
    entityType: 'estimate' | 'invoice';
    entityId: string;
    target: ChannelTarget;
    render: () => SmsMessage | EmailMessage;
  }): Promise<SendResult['channelsSent'][number]> {
    const message = args.render();
    let providerMessageId: string;
    let provider: string;

    if (args.target.channel === 'sms') {
      const result = await this.deps.delivery.sendSms({
        ...(message as SmsMessage),
        tenantId: args.tenantId,
      });
      providerMessageId = result.providerMessageId;
      provider = result.provider;
    } else {
      const result = await this.deps.delivery.sendEmail({
        ...(message as EmailMessage),
        tenantId: args.tenantId,
      });
      providerMessageId = result.providerMessageId;
      provider = result.provider;
    }

    const dispatch = await this.deps.dispatchRepo.create({
      tenantId: args.tenantId,
      entityType: args.entityType,
      entityId: args.entityId,
      channel: args.target.channel,
      recipient: args.target.recipient,
      provider,
      providerMessageId,
      status: 'sent',
    });

    return {
      channel: args.target.channel,
      recipient: args.target.recipient,
      provider,
      providerMessageId,
      dispatchId: dispatch.id,
    };
  }
}

interface ChannelTarget {
  channel: 'sms' | 'email';
  recipient: string;
}

function resolveChannels(args: {
  channel: SendChannel;
  customer: { primaryPhone?: string; email?: string };
  recipientPhone?: string;
  recipientEmail?: string;
}): ChannelTarget[] {
  const targets: ChannelTarget[] = [];
  const wantSms = args.channel === 'sms' || args.channel === 'both';
  const wantEmail = args.channel === 'email' || args.channel === 'both';

  if (wantSms) {
    const phone = args.recipientPhone ?? args.customer.primaryPhone;
    if (!phone) {
      throw new ValidationError(
        'Cannot send SMS — no phone number provided and customer has no primary phone'
      );
    }
    targets.push({ channel: 'sms', recipient: phone });
  }
  if (wantEmail) {
    const email = args.recipientEmail ?? args.customer.email;
    if (!email) {
      throw new ValidationError(
        'Cannot send email — no email provided and customer has no email on file'
      );
    }
    targets.push({ channel: 'email', recipient: email });
  }
  if (targets.length === 0) {
    throw new ValidationError(
      `Invalid channel: ${args.channel}. Must be sms, email, or both.`
    );
  }
  return targets;
}

function generateViewToken(): string {
  return randomBytes(24).toString('base64url');
}
