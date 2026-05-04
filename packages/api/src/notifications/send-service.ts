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
import { DeliveryError } from './notification-errors';

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
    const viewTokenExpiresAt =
      estimate.viewTokenExpiresAt ?? new Date(Date.now() + ESTIMATE_TOKEN_TTL_MS);
    const viewUrl = this.buildViewUrl('e', viewToken);

    // Persist the token before sending — if delivery succeeds but the final DB
    // update fails, the customer would hold a link with a non-existent token.
    if (!estimate.viewToken) {
      await this.deps.estimateRepo.update(input.tenantId, estimate.id, {
        viewToken,
        viewTokenExpiresAt,
        updatedAt: new Date(),
      });
    }

    const channels = resolveChannels({
      channel: input.channel,
      customer,
      recipientPhone: input.recipientPhone,
      recipientEmail: input.recipientEmail,
    });

    // Run all channels in parallel — halves p50 latency for channel: 'both'.
    // Any individual channel failure is recorded as a failed dispatch row in
    // the audit table without aborting the others (Promise.allSettled).
    const sendStartedAt = Date.now();
    const results = await Promise.allSettled(
      channels.map((target) =>
        this.dispatchOne({
          tenantId: input.tenantId,
          entityType: 'estimate',
          entityId: estimate.id,
          target,
          idempotencyKey: this.buildIdempotencyKey(
            'estimate',
            estimate.id,
            target.channel,
            sendStartedAt
          ),
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
        })
      )
    );

    const sent: SendResult['channelsSent'] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        sent.push(r.value);
      } else {
        const target = channels[i];
        errors.push(
          `${target.channel} to ${target.recipient}: ${
            mapDeliveryErrorForClient(r.reason)
          }`
        );
      }
    });

    if (sent.length === 0) {
      throw new ValidationError(
        `Estimate send failed on all channels: ${errors.join('; ')}`
      );
    }

    const now = new Date();
    await this.deps.estimateRepo.update(input.tenantId, estimate.id, {
      viewToken,
      viewTokenExpiresAt,
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
    const viewTokenExpiresAt =
      invoice.viewTokenExpiresAt ?? new Date(Date.now() + INVOICE_TOKEN_TTL_MS);
    const viewUrl = this.buildViewUrl('pay', viewToken);

    // Persist the token before sending — if delivery succeeds but the final DB
    // update fails, the customer would hold a link with a non-existent token.
    if (!invoice.viewToken) {
      await this.deps.invoiceRepo.update(input.tenantId, invoice.id, {
        viewToken,
        viewTokenExpiresAt,
        updatedAt: new Date(),
      });
    }

    const channels = resolveChannels({
      channel: input.channel,
      customer,
      recipientPhone: input.recipientPhone,
      recipientEmail: input.recipientEmail,
    });

    const sendStartedAt = Date.now();
    const results = await Promise.allSettled(
      channels.map((target) =>
        this.dispatchOne({
          tenantId: input.tenantId,
          entityType: 'invoice',
          entityId: invoice.id,
          target,
          idempotencyKey: this.buildIdempotencyKey(
            'invoice',
            invoice.id,
            target.channel,
            sendStartedAt
          ),
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
        })
      )
    );

    const sent: SendResult['channelsSent'] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        sent.push(r.value);
      } else {
        const target = channels[i];
        errors.push(
          `${target.channel} to ${target.recipient}: ${
            mapDeliveryErrorForClient(r.reason)
          }`
        );
      }
    });

    if (sent.length === 0) {
      throw new ValidationError(
        `Invoice send failed on all channels: ${errors.join('; ')}`
      );
    }

    const now = new Date();
    await this.deps.invoiceRepo.update(input.tenantId, invoice.id, {
      viewToken,
      viewTokenExpiresAt,
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

  /**
   * Stable per-attempt key. Quantizes the timestamp to a 1-minute window
   * so a user double-clicking "Send" within seconds dedupes at the
   * provider, while a deliberate re-send 5 minutes later is treated as
   * a new dispatch.
   */
  private buildIdempotencyKey(
    entityType: 'estimate' | 'invoice',
    entityId: string,
    channel: 'sms' | 'email',
    nowMs: number
  ): string {
    const minute = Math.floor(nowMs / 60_000);
    return `${entityType}:${entityId}:${channel}:${minute}`;
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
    /** Stable dedupe key — provider should reject identical retries within ~24h. */
    idempotencyKey: string;
  }): Promise<SendResult['channelsSent'][number]> {
    const message = args.render();
    let providerMessageId: string;
    let provider: string;

    try {
      if (args.target.channel === 'sms') {
        const result = await this.deps.delivery.sendSms({
          ...(message as SmsMessage),
          tenantId: args.tenantId,
          idempotencyKey: args.idempotencyKey,
        });
        providerMessageId = result.providerMessageId;
        provider = result.provider;
      } else {
        const result = await this.deps.delivery.sendEmail({
          ...(message as EmailMessage),
          tenantId: args.tenantId,
          idempotencyKey: args.idempotencyKey,
        });
        providerMessageId = result.providerMessageId;
        provider = result.provider;
      }
    } catch (err) {
      // Audit the failed attempt before propagating, so support has a
      // record of every channel attempt (success or failure).
      await this.deps.dispatchRepo
        .create({
          tenantId: args.tenantId,
          entityType: args.entityType,
          entityId: args.entityId,
          channel: args.target.channel,
          recipient: args.target.recipient,
          provider: 'unknown',
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : 'unknown error',
          idempotencyKey: args.idempotencyKey,
        })
        .catch(() => {
          // Best-effort audit — never let failure-to-record-failure mask the original error.
        });
      throw err;
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
      idempotencyKey: args.idempotencyKey,
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

function mapDeliveryErrorForClient(err: unknown): string {
  if (err instanceof DeliveryError) {
    return err.code === 'AUTH_FAILED'
      ? 'delivery authentication failed'
      : 'delivery provider failed';
  }
  return err instanceof Error ? err.message : 'unknown error';
}

function generateViewToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 90 days for estimate view links — matches typical quote validity windows. */
const ESTIMATE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 60 days for invoice payment links — covers Net-30 plus dunning. */
const INVOICE_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
