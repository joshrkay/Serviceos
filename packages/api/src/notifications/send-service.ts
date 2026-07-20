import { randomBytes } from 'crypto';
import { CustomerRepository } from '../customers/customer';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository, InvoiceStatus } from '../invoices/invoice';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { ValidationError, NotFoundError, ConflictError } from '../shared/errors';
import { DispatchRepository } from './dispatch-repository';
import {
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from './delivery-provider';
import { SmsSuppressedError } from './gated-message-delivery';
import {
  renderEstimateEmail,
  renderEstimateSms,
  renderInvoiceEmail,
  renderInvoiceSms,
} from './templates';
import { DeliveryError } from './notification-errors';
import { resolveCustomerLanguage } from '../i18n/resolve-language';

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

/**
 * Invoices in these statuses cannot be usefully sent to a customer for
 * payment. 'draft' hasn't been issued yet (no issuedAt/dueDate), and both
 * payment-link paths reject anything outside ['open', 'partially_paid'];
 * 'void'/'canceled' are dead invoices with nothing to collect. See the
 * sendInvoice() guard below.
 */
const UNSENDABLE_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  'draft',
  'void',
  'canceled',
]);
 * Codex P1 #2 follow-up. Callers that wrap `sendEstimate`/`sendInvoice` in
 * `withSendClaim` (see estimates/estimate-nudge.ts) thread `withSendClaim`'s
 * `markProviderAccepted` signal in as `onProviderAccepted`. This method calls
 * it the instant the customer has actually received the message — i.e. right
 * after the channel dispatch succeeds, before the entity-write bookkeeping
 * below (estimate.sentAt / lastDispatchId / status, invoice.sentAt, etc.). If
 * that bookkeeping write then throws, `withSendClaim` finalizes the claim to
 * 'sent' instead of releasing it: the provider already accepted the message,
 * so releasing would let a retry duplicate the send. Callers that don't wrap
 * this in a claim (the direct "Send Estimate/Invoice" routes, the proposal
 * delivery adapters) simply omit this option — a no-op.
 */
export interface SendEntityOptions {
  onProviderAccepted?: () => void;
  /**
   * Codex P1 (PR #705) — awaited immediately before the provider dispatch,
   * AFTER all pre-provider prep (repo lookups, view-token persistence). A
   * claim wrapper threads `withSendClaim`'s `markProviderStarting` here so the
   * `claimed → sending` transition only happens once the provider is actually
   * about to be called — keeping the claim reclaimable if the process crashes
   * during prep. May reject (the deferred CAS lost to a concurrent reclaimer);
   * that rejection propagates out un-caught so the send is aborted before
   * dispatch. Callers that don't wrap this in a claim omit it — a no-op.
   */
  onProviderStarting?: () => void | Promise<void>;
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

  async sendEstimate(input: SendEstimateInput, options?: SendEntityOptions): Promise<SendResult> {
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

    const { businessName, tenantDefaultLanguage } = await this.resolveBusinessContext(input.tenantId);
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage,
    });
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

    // Codex P1 (PR #705) — the provider dispatch begins NOW. Signal any claim
    // wrapper so it flips its claim to 'sending' at this instant (not before
    // the prep above). May reject if the deferred claim CAS was lost to a
    // concurrent reclaimer, in which case we must NOT dispatch — the rejection
    // propagates out un-caught and aborts the send before any channel is hit.
    await options?.onProviderStarting?.();

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
          customerSmsConsent: customer.smsConsent,
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
                  language,
                })
              : this.renderEstimateEmailMessage(target.recipient, {
                  customerName: customer.displayName,
                  estimateNumber: estimate.estimateNumber,
                  totalCents: estimate.totals.totalCents,
                  businessName,
                  viewUrl,
                  customMessage: input.customMessage,
                  language,
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

    // Codex P1 #2 follow-up — the customer has now actually received this
    // estimate on at least one channel. Signal any claim wrapper BEFORE the
    // entity write below, so a throw from that write finalizes the claim
    // instead of releasing it (see SendEntityOptions doc).
    options?.onProviderAccepted?.();

    const now = new Date();
    await this.deps.estimateRepo.update(input.tenantId, estimate.id, {
      viewToken,
      viewTokenExpiresAt,
      // Set-once: sentAt records the FIRST send so re-sends (e.g. the
      // reminder worker) don't overwrite the original send date the UI and
      // voice readback display. lastDispatchId still tracks the latest send.
      sentAt: estimate.sentAt ?? now,
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

  async sendInvoice(input: SendInvoiceInput, options?: SendEntityOptions): Promise<SendResult> {
    const invoice = await this.deps.invoiceRepo.findById(
      input.tenantId,
      input.invoiceId
    );
    if (!invoice) {
      throw new NotFoundError('Invoice', input.invoiceId);
    }

    // QA 2026-07-19 — "Send payment link" on a still-draft invoice used to
    // 202 and silently do nothing: this method only ever stamps
    // sentAt/viewToken/lastDispatchId (see the status-transition note below),
    // it never issues the invoice. A 'draft' invoice has no issuedAt/dueDate,
    // and both payment-link paths (createInvoicePaymentLink in
    // invoices/invoice-payment-link.ts and
    // PublicInvoiceService.getOrCreateCheckoutUrl) refuse anything outside
    // ['open', 'partially_paid'] — so the "view" link we'd email/text the
    // customer could never produce a working payment link, and nothing told
    // the operator. 'void'/'canceled' are dead invoices with nothing to
    // collect — sending a payment prompt for one is actively wrong, not just
    // ineffective. Fail fast, before attempting any delivery, with a message
    // that tells the operator exactly what to do next.
    if (UNSENDABLE_INVOICE_STATUSES.has(invoice.status)) {
      throw new ConflictError(
        invoice.status === 'draft'
          ? `Invoice ${invoice.invoiceNumber} is still a draft — issue it (POST /:id/issue, which sets a due date) before sending a payment link to the customer.`
          : `Invoice ${invoice.invoiceNumber} is ${invoice.status} — there is nothing to collect, so it cannot be sent to the customer for payment.`
      );
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

    const { businessName, tenantDefaultLanguage } = await this.resolveBusinessContext(input.tenantId);
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage,
    });
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
          customerSmsConsent: customer.smsConsent,
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
                  language,
                })
              : this.renderInvoiceEmailMessage(target.recipient, {
                  customerName: customer.displayName,
                  invoiceNumber: invoice.invoiceNumber,
                  totalCents: invoice.totals.totalCents,
                  businessName,
                  viewUrl,
                  dueDateIso: invoice.dueDate?.toISOString(),
                  customMessage: input.customMessage,
                  language,
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

    // Codex P1 #2 follow-up — see the matching call in sendEstimate above.
    // No current caller wraps sendInvoice in withSendClaim (the direct send
    // routes/adapters are one-shot, not claim-guarded), but this keeps the
    // method safe to compose that way later without a silent gap.
    options?.onProviderAccepted?.();

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

  private async resolveBusinessContext(
    tenantId: string,
  ): Promise<{ businessName: string; tenantDefaultLanguage?: string | null }> {
    const settings = await this.deps.settingsRepo.findByTenant(tenantId);
    return {
      businessName: settings?.businessName ?? 'Your service team',
      tenantDefaultLanguage: settings?.defaultLanguage ?? null,
    };
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
    return { to, body, recipientClass: 'customer' };
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
    return { to, body, recipientClass: 'customer' };
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
    /**
     * Customer's stored sms_consent flag. SMS sends require an explicit
     * true here. Undefined is treated as not-yet-asked — also blocked.
     */
    customerSmsConsent?: boolean;
  }): Promise<SendResult['channelsSent'][number]> {
    // §7 / WS1: the consent + DNC gate now lives in the single
    // GatedMessageDelivery wrapper (notifications/gated-message-delivery.ts).
    // SMS sends here just declare the audience (customer) and forward the
    // stored consent flag; a suppressed send throws SmsSuppressedError, which
    // we translate below into the SAME provider='suppressed' failed dispatch
    // row + re-throw the assertion path previously produced inline — so the
    // Promise.allSettled in sendEstimate/sendInvoice still surfaces it as a
    // partial failure rather than a silent skip, and the UX contract is intact.
    const message = args.render();
    let providerMessageId: string;
    let provider: string;

    try {
      if (args.target.channel === 'sms') {
        const result = await this.deps.delivery.sendSms({
          ...(message as SmsMessage),
          tenantId: args.tenantId,
          idempotencyKey: args.idempotencyKey,
          recipientClass: 'customer',
          consent: { smsConsent: args.customerSmsConsent === true },
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
      // record of every channel attempt (success or failure). A gate
      // suppression is recorded with provider='suppressed' (as before);
      // any other transport failure stays provider='unknown'.
      const suppressed = err instanceof SmsSuppressedError;
      await this.deps.dispatchRepo
        .create({
          tenantId: args.tenantId,
          entityType: args.entityType,
          entityId: args.entityId,
          channel: args.target.channel,
          recipient: args.target.recipient,
          provider: suppressed ? 'suppressed' : 'unknown',
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
