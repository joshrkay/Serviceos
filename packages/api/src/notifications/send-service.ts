import { randomBytes } from 'crypto';
import { CustomerRepository } from '../customers/customer';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository, InvoiceStatus } from '../invoices/invoice';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { AppError, ValidationError, NotFoundError, ConflictError } from '../shared/errors';
import { UNKNOWN_PROVIDER, type DispatchRepository } from './dispatch-repository';
import { outboundClaimKey, type OutboundMessaging, type OutboundText, type RecordedSendOutcome } from './outbound-messaging';
import {
  EmailMessage,
  MessageDeliveryProvider,
  SmsQuietHoursPolicy,
} from './delivery-provider';
import {
  EmailSuppressedError,
  SmsDeferredError,
  SmsSuppressedError,
  type SmsSuppressionReason,
} from './gated-message-delivery';
import {
  renderEstimateEmail,
  renderEstimateSms,
  renderInvoiceEmail,
  renderInvoiceSms,
  renderPortalLinkEmail,
  renderPortalLinkSms,
  smsInvoiceCollectOnSiteLine,
} from './templates';
import type { CustomerTextWording, WordingPurpose } from './customer-text-wording';
import type { Language } from '../ai/i18n/i18n';
import { formatUsdCentsPlain } from '@ai-service-os/shared';
import { DeliveryError } from './notification-errors';
import { createLogger } from '../logging/logger';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import type { AuditRepository } from '../audit/audit';
import { auditPaymentModeUnavailable, readPaymentCollectionMode } from '../invoices/payment-collection-mode';
import type { PaymentCollectionMode } from '../settings/settings';

const sendLogger = createLogger({ service: 'send-service', environment: process.env.NODE_ENV || 'dev' });

export type SendChannel = 'sms' | 'email' | 'both' | 'auto';

/**
 * D-045 — the channel a send with no channel named goes out on: a text when
 * the customer has a phone on file and agreed to texts; otherwise their
 * email; otherwise a text to whatever phone is on file (the gate then
 * refuses it with the reason); nothing when neither is on file. An opt-out
 * is left to the delivery gate, which reads the current consent ledger (a
 * START after a STOP clears it there while `consentStatus` stays 'revoked'),
 * and a text it refuses falls back to the email (`withEmailFallback`). The
 * one rule the approval-time recipient check and the send itself share.
 * Supersedes #1524's email-first default.
 */
export function defaultSendChannel(customer: {
  email?: string | null;
  primaryPhone?: string | null;
  smsConsent?: boolean;
}): 'email' | 'sms' | undefined {
  const hasPhone = typeof customer.primaryPhone === 'string' && customer.primaryPhone.trim().length > 0;
  const hasEmail = typeof customer.email === 'string' && customer.email.trim().length > 0;
  if (hasPhone && customer.smsConsent === true) return 'sms';
  if (hasEmail) return 'email';
  if (hasPhone) return 'sms';
  return undefined;
}

/**
 * #1145 — caller-supplied tag identifying WHY this send is happening,
 * folded into the dispatch idempotency key (see `buildIdempotencyKey`)
 * alongside entity + channel + recipient. Two sends for the same
 * entity+channel in the same wall-clock minute are the SAME occasion only
 * when they also share this context — an owner's manual send
 * (`'owner'`) and an automatic reminder occurrence
 * (`nudge:v{version}:{occurrence}`) are legitimately independent and must
 * both go out, not collide as duplicates. Omit it only for a caller with no
 * distinguishable occasion (defaults to `'default'`); every caller that
 * ALSO has another caller sending the same kind of entity+channel should
 * set a distinct value here so the two can never collide by accident.
 */
type IdempotencyContext = string;

export interface SendEstimateInput {
  tenantId: string;
  estimateId: string;
  channel: SendChannel;
  /** Override recipient. Defaults to customer's preferred channel value. */
  recipientPhone?: string;
  recipientEmail?: string;
  customMessage?: string;
  idempotencyContext?: IdempotencyContext;
  /**
   * 'defer' for a non-transactional resend (the automatic reminder sweep):
   * its text goes as an automated nudge, which waits for the customer's
   * daytime window and needs their own SMS consent (D-045). When every
   * channel is held back by quiet hours the send throws `SmsDeferredError`,
   * and the text's message record says when it can go.
   */
  quietHours?: SmsQuietHoursPolicy;
}

export interface SendInvoiceInput {
  tenantId: string;
  invoiceId: string;
  channel: SendChannel;
  recipientPhone?: string;
  recipientEmail?: string;
  customMessage?: string;
  idempotencyContext?: IdempotencyContext;
}

/**
 * Portal-link delivery (routes/portal.ts mint+send). Unlike estimates and
 * invoices, the portal session stores only a token HASH — the plaintext URL
 * exists exactly once, at mint time — so the caller mints the session and
 * hands the composed URL in. This method owns everything downstream:
 * recipient resolution, template rendering, the consent/DNC-gated dispatch,
 * and the dispatch-ledger rows keyed to the portal session.
 */
export interface SendPortalLinkInput {
  tenantId: string;
  customerId: string;
  /** portal_sessions.id the link belongs to — dispatch rows key on it. */
  portalSessionId: string;
  /** Plaintext portal URL (contains the bearer token). */
  portalUrl: string;
  /** Session expiry — rendered in the message so the customer knows. */
  expiresAt?: Date;
  channel: SendChannel;
  recipientPhone?: string;
  recipientEmail?: string;
  customMessage?: string;
  idempotencyContext?: IdempotencyContext;
}

export interface SendPortalLinkResult {
  portalSessionId: string;
  portalUrl: string;
  channelsSent: SendResult['channelsSent'];
}

/**
 * Invoices in these statuses cannot be usefully sent to a customer for
 * payment. 'draft' hasn't been issued yet (no issuedAt/dueDate), and both
 * payment-link paths reject anything outside ['open', 'partially_paid'];
 * 'void'/'canceled' are dead invoices with nothing to collect. See the
 * sendInvoice() guard below.
 */
export const UNSENDABLE_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  'draft',
  'void',
  'canceled',
]);

/**
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
  /**
   * S5a-1 (U8) — invoice sends only: the payment policy applied AT SEND
   * TIME (`pay_link` CTA or `collect_on_site` note). Routes record it on
   * their `invoice.sent` audit event. D-045 — a policy that can't be read
   * refuses the send, so there is no view-only outcome.
   */
  paymentCollectionMode?: PaymentCollectionMode;
  channelsSent: Array<{
    channel: 'sms' | 'email';
    recipient: string;
    provider: string;
    /** The provider's receipt; absent when this send replayed one whose receipt is unknown. */
    providerMessageId?: string;
    /** The message record; absent only when writing it failed (logged). */
    dispatchId?: string;
  }>;
}

export interface SendServiceDeps {
  /** Email goes straight to the gated delivery; texts go through `outbound`. */
  delivery: MessageDeliveryProvider;
  /**
   * D-045 — every text goes through outbound messaging, which records it as
   * the job's and customer's message record (sent, held, or blocked and why).
   */
  outbound: OutboundMessaging;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
  dispatchRepo: DispatchRepository;
  /**
   * S5a-1 (U8) — optional only for legacy harnesses: the invoice send audits
   * `invoice.payment_mode_unavailable` (surface `send`) when the policy read
   * fails and the send is refused.
   */
  auditRepo?: AuditRepository;
  /**
   * D-045 — makes (or finds) the invoice's hosted pay link; throws when it
   * can't. Called before an invoice in `pay_link` mode with a balance due is
   * sent, so the customer never gets an invoice they can't pay
   * (`createInvoicePaymentLink` in app.ts).
   */
  ensureInvoicePayLink: (tenantId: string, invoiceId: string) => Promise<unknown>;
  publicBaseUrl: string;
  /**
   * D-045 — the owner's own wording for the estimate, invoice and portal-link
   * texts. Absent (legacy harnesses) means our wording.
   */
  wording?: CustomerTextWording;
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

    // Read the owner's wording once, before any channel goes out: the
    // channels run in parallel on the request's one connection, and the
    // read's savepoint must not interleave with their writes.
    const smsText = channels.some((t) => t.channel === 'sms')
      ? await this.textInWording({
          tenantId: input.tenantId,
          purpose: 'estimate_text',
          customerLanguage: language,
          values: {
            customer_name: customer.displayName,
            business_name: businessName,
            number: estimate.estimateNumber,
            total: formatUsdCentsPlain(estimate.totals.totalCents),
            link: viewUrl,
          },
          note: input.customMessage,
          builtIn: () =>
            renderEstimateSms({
              customerName: customer.displayName,
              estimateNumber: estimate.estimateNumber,
              totalCents: estimate.totals.totalCents,
              businessName,
              viewUrl,
              customMessage: input.customMessage,
              language,
            }).body,
        })
      : '';
    // Any individual channel failure is recorded as a failed dispatch row in
    // the audit table without aborting the others (Promise.allSettled).
    const sendStartedAt = Date.now();
    const purpose = input.quietHours === 'defer' ? 'automated_nudge' : 'transactional';
    const dispatchTo = (target: ChannelTarget) =>
      this.dispatchOne({
        tenantId: input.tenantId,
        entityType: 'estimate',
        entityId: estimate.id,
        target,
        purpose,
        customerId: customer.id,
        jobId: job.id,
        // An automatic reminder's context already names its occurrence, so its
        // text keeps one key (and one message record, which each outcome
        // replaces) across the sweeps that retry it after quiet hours. An email
        // row is never replaced, so a reminder email, like a send now, keeps
        // its minute and a retried failure gets a fresh row.
        dedupe: this.buildDedupe(
          'estimate',
          estimate.id,
          target,
          input.idempotencyContext ?? 'default',
          purpose === 'automated_nudge' && target.channel === 'sms' ? undefined : sendStartedAt,
        ),
        render: () =>
          target.channel === 'sms'
            ? smsText
            : this.renderEstimateEmailMessage(target.recipient, {
                customerName: customer.displayName,
                estimateNumber: estimate.estimateNumber,
                totalCents: estimate.totals.totalCents,
                businessName,
                viewUrl,
                customMessage: input.customMessage,
                language,
              }),
      });
    // Run all channels in parallel — halves p50 latency for channel: 'both'.
    // Except a deferrable multi-channel send, which waits whole: its text goes
    // first and, if quiet hours hold it back, nothing is sent — never the
    // email alone while its text is dropped.
    const smsTarget =
      input.quietHours === 'defer' && channels.length > 1
        ? channels.find((t) => t.channel === 'sms')
        : undefined;
    const smsFirst = async (sms: ChannelTarget) => {
      const [smsResult] = await Promise.allSettled([dispatchTo(sms)]);
      if (smsResult.status === 'rejected' && smsResult.reason instanceof SmsDeferredError) {
        throw smsResult.reason;
      }
      const rest = await Promise.allSettled(
        channels.filter((t) => t !== sms).map((t) => dispatchTo(t)),
      );
      return channels.map((t) => (t === sms ? smsResult : rest.shift()!));
    };
    const firstResults = smsTarget
      ? await smsFirst(smsTarget)
      : await Promise.allSettled(channels.map((t) => dispatchTo(t)));
    const { tried, results } = await withEmailFallback({
      channel: input.channel,
      email: input.recipientEmail ?? customer.email,
      channels,
      results: firstResults,
      dispatch: dispatchTo,
    });

    const sent = settleChannels('Estimate', tried, results);

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
      lastDispatchId: latestDispatchId(sent),
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

    // S5a-1 (U8) — ONE settings read decides both the business context and
    // the payment policy the message renders. D-045 — an invoice never goes
    // out without the pay link its policy calls for: a read that throws
    // refuses the send (it used to go out view-only), and in `pay_link` mode
    // with a balance due the link is made now, before anything is sent. If it
    // can't be made the send is refused with the reason, and the caller shows
    // it (an owner's send) or records it (an automatic one).
    const modeRead = await readPaymentCollectionMode(this.deps.settingsRepo, input.tenantId);
    if (!modeRead.ok) {
      await auditPaymentModeUnavailable(this.deps.auditRepo, {
        tenantId: input.tenantId,
        invoiceId: invoice.id,
        surface: 'send',
        error: modeRead.error,
      });
      throw new PayLinkUnavailableError(
        invoice.invoiceNumber,
        "this business's payment setting couldn't be read",
      );
    }
    const paymentCollectionMode = modeRead.mode;
    const settingsRow = modeRead.settings;
    // Who it goes to is settled before a pay link is made, so a send with no
    // recipient never mints a Stripe link it then rolls back.
    const channels = resolveChannels({
      channel: input.channel,
      customer,
      recipientPhone: input.recipientPhone,
      recipientEmail: input.recipientEmail,
    });
    if (paymentCollectionMode === 'pay_link' && invoice.amountDueCents > 0) {
      try {
        await this.deps.ensureInvoicePayLink(input.tenantId, invoice.id);
      } catch (err) {
        // Our own refusals (AppError) are written for the owner; anything else
        // is a raw provider error (Stripe's HTTP body, ids), which stays in the
        // server log and never reaches the screen.
        if (!(err instanceof AppError)) {
          sendLogger.warn('invoice pay link could not be made; send refused', {
            tenantId: input.tenantId,
            invoiceId: invoice.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw new PayLinkUnavailableError(
          invoice.invoiceNumber,
          err instanceof AppError ? err.message : 'the payment provider did not answer',
        );
      }
    }
    const businessName = settingsRow?.businessName ?? 'Your service team';
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage: settingsRow?.defaultLanguage ?? null,
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

    // Read the owner's wording once, before any channel goes out: the
    // channels run in parallel on the request's one connection, and the
    // read's savepoint must not interleave with their writes.
    const smsText = channels.some((t) => t.channel === 'sms')
      ? await this.textInWording({
          tenantId: input.tenantId,
          purpose: 'invoice_text',
          customerLanguage: language,
          values: {
            customer_name: customer.displayName,
            business_name: businessName,
            number: invoice.invoiceNumber,
            total: formatUsdCentsPlain(invoice.totals.totalCents),
            link: viewUrl,
          },
          note: input.customMessage,
          // The owner's wording can't know the invoice is paid in
          // person, so that line is always ours.
          extraLines: smsInvoiceCollectOnSiteLine({ businessName, language, paymentCollectionMode }),
          builtIn: () =>
            renderInvoiceSms({
              customerName: customer.displayName,
              invoiceNumber: invoice.invoiceNumber,
              totalCents: invoice.totals.totalCents,
              businessName,
              viewUrl,
              dueDateIso: invoice.dueDate?.toISOString(),
              customMessage: input.customMessage,
              language,
              paymentCollectionMode,
            }).body,
        })
      : '';
    const sendStartedAt = Date.now();
    const dispatchTo = (target: ChannelTarget) =>
      this.dispatchOne({
        tenantId: input.tenantId,
        entityType: 'invoice',
        entityId: invoice.id,
        target,
        purpose: 'transactional',
        customerId: customer.id,
        jobId: job.id,
        dedupe: this.buildDedupe(
          'invoice',
          invoice.id,
          target,
          input.idempotencyContext ?? 'default',
          sendStartedAt,
        ),
        render: () =>
          target.channel === 'sms'
            ? smsText
            : this.renderInvoiceEmailMessage(target.recipient, {
                customerName: customer.displayName,
                invoiceNumber: invoice.invoiceNumber,
                totalCents: invoice.totals.totalCents,
                businessName,
                viewUrl,
                dueDateIso: invoice.dueDate?.toISOString(),
                customMessage: input.customMessage,
                language,
                paymentCollectionMode,
              }),
      });
    const { tried, results } = await withEmailFallback({
      channel: input.channel,
      email: input.recipientEmail ?? customer.email,
      channels,
      results: await Promise.allSettled(channels.map((t) => dispatchTo(t))),
      dispatch: dispatchTo,
    });

    const sent = settleChannels('Invoice', tried, results);

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
      lastDispatchId: latestDispatchId(sent),
      updatedAt: now,
    });

    return {
      invoiceId: invoice.id,
      viewUrl,
      viewToken,
      channelsSent: sent,
      paymentCollectionMode,
    };
  }

  /**
   * Portal-link variant of the estimate/invoice send shape. No entity
   * write-back happens here — portal_sessions has no sentAt column; the
   * dispatch ledger plus the route's portal_session.link_sent audit event
   * carry the record. Consent/DNC gating is identical to the other sends:
   * every SMS goes through the gated `delivery` with the customer's stored
   * consent flag, and a suppression surfaces as a failed channel.
   */
  async sendPortalLink(input: SendPortalLinkInput): Promise<SendPortalLinkResult> {
    const customer = await this.deps.customerRepo.findById(
      input.tenantId,
      input.customerId
    );
    if (!customer) {
      throw new NotFoundError('Customer', input.customerId);
    }

    const { businessName, tenantDefaultLanguage } = await this.resolveBusinessContext(input.tenantId);
    const language = resolveCustomerLanguage({
      customerPreferredLanguage: customer.preferredLanguage,
      tenantDefaultLanguage,
    });

    const channels = resolveChannels({
      channel: input.channel,
      customer,
      recipientPhone: input.recipientPhone,
      recipientEmail: input.recipientEmail,
    });

    const templateCtx = {
      customerName: customer.displayName,
      businessName,
      portalUrl: input.portalUrl,
      expiresAtIso: input.expiresAt?.toISOString(),
      customMessage: input.customMessage,
      language,
    };

    // Read the owner's wording once, before any channel goes out: the
    // channels run in parallel on the request's one connection, and the
    // read's savepoint must not interleave with their writes.
    const smsText = channels.some((t) => t.channel === 'sms')
      ? await this.textInWording({
          tenantId: input.tenantId,
          purpose: 'portal_link_text',
          customerLanguage: language,
          values: {
            customer_name: customer.displayName,
            business_name: businessName,
            link: input.portalUrl,
          },
          note: input.customMessage,
          builtIn: () => renderPortalLinkSms(templateCtx).body,
        })
      : '';
    const sendStartedAt = Date.now();
    const results = await Promise.allSettled(
      channels.map((target) =>
        this.dispatchOne({
          tenantId: input.tenantId,
          entityType: 'portal_session',
          entityId: input.portalSessionId,
          target,
          purpose: 'transactional',
          customerId: customer.id,
          dedupe: this.buildDedupe(
            'portal_session',
            input.portalSessionId,
            target,
            input.idempotencyContext ?? 'default',
            sendStartedAt,
          ),
          render: () =>
            target.channel === 'sms'
              ? smsText
              : { to: target.recipient, ...renderPortalLinkEmail(templateCtx) },
        })
      )
    );

    const sent = settleChannels('Portal link', channels, results);

    return {
      portalSessionId: input.portalSessionId,
      portalUrl: input.portalUrl,
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

  /** The owner's wording for this text when it applies, else ours (`builtIn`). */
  private async textInWording(args: {
    tenantId: string;
    purpose: WordingPurpose;
    customerLanguage: Language;
    values: Record<string, string>;
    note?: string;
    extraLines?: readonly string[];
    builtIn: () => string;
  }): Promise<string> {
    return this.deps.wording ? this.deps.wording.textFor(args) : args.builtIn();
  }

  private buildViewUrl(prefix: 'e' | 'pay', token: string): string {
    const base = this.deps.publicBaseUrl.replace(/\/$/, '');
    return `${base}/${prefix}/${token}`;
  }

  /**
   * #1145 — keyed on the send's semantic identity: entity + channel +
   * recipient + the caller-supplied `context` (see `IdempotencyContext`),
   * NOT just entity + channel + minute. The bare entity+channel+minute key
   * this replaced could not tell an owner's manual send apart from an
   * unrelated automatic reminder landing in the same wall-clock minute —
   * both are legitimate, independent sends, but shared the exact same key
   * and collided on `idx_dispatches_idempotency`
   * (`UNIQUE (tenant_id, idempotency_key)`), so the second was rejected as
   * if it were a duplicate of the first.
   *
   * The minute quantization is KEPT, but now only as a short retry window
   * for TRUE duplicates of the same occasion (e.g. a double-tapped "Send"
   * button re-invoking with the same context within the same minute) — the
   * `context` segment is what makes two DIFFERENT occasions distinct
   * instead of merely two attempts at the same one. A send with no
   * `retryWindowFrom` (an automatic reminder whose context already names
   * the occurrence) has no minute: one occasion, one key.
   *
   * D-045 — the key is `outboundClaimKey(dedupe)`, so a text's outbound
   * claim, its message record and an email's dispatch row share one key.
   */
  private buildDedupe(
    entityType: 'estimate' | 'invoice' | 'portal_session',
    entityId: string,
    target: ChannelTarget,
    context: IdempotencyContext,
    retryWindowFrom: number | undefined,
  ): OutboundText['dedupe'] {
    const occasion = `${entityId}:${target.channel}:${target.recipient}:${context}`;
    return {
      messageKind: entityType,
      recordId:
        retryWindowFrom === undefined ? occasion : `${occasion}:${Math.floor(retryWindowFrom / 60_000)}`,
    };
  }

  private renderEstimateEmailMessage(
    to: string,
    ctx: Parameters<typeof renderEstimateEmail>[0]
  ): EmailMessage {
    const { subject, text, html } = renderEstimateEmail(ctx);
    return { to, subject, text, html };
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
    entityType: 'estimate' | 'invoice' | 'portal_session';
    entityId: string;
    target: ChannelTarget;
    /** The text's body, or the email. */
    render: () => string | EmailMessage;
    /** Stable dedupe identity (see `buildDedupe`). */
    dedupe: OutboundText['dedupe'];
    /** A send now, or an automatic reminder (waits for daytime, needs consent). */
    purpose: 'transactional' | 'automated_nudge';
    /** Who the message is to and the job it is about, for its message record. */
    customerId: string;
    jobId?: string;
  }): Promise<ChannelSent> {
    const idempotencyKey = outboundClaimKey(args.dedupe);
    // #1400 — a same-occasion retry (same entity, channel, recipient and
    // context inside the idempotency minute, e.g. a double-tapped Resend)
    // already went out: replay that dispatch instead of messaging the
    // customer twice and tripping idx_dispatches_idempotency (which surfaced
    // to the owner as a raw "duplicate key" 400).
    const prior = await this.deps.dispatchRepo.findByIdempotencyKey?.(args.tenantId, idempotencyKey);
    const replay = (): ChannelSent => ({
      channel: args.target.channel,
      recipient: args.target.recipient,
      provider: prior!.provider,
      ...(prior!.providerMessageId ? { providerMessageId: prior!.providerMessageId } : {}),
      dispatchId: prior!.id,
    });

    const message = args.render();
    if (args.target.channel === 'sms') {
      // A text that went out replays. One the carrier reported failed or
      // bounced was still sent under this key, so it is not sent again in
      // the same minute, and the owner is told so rather than shown "sent".
      // A held or blocked one goes back through outbound messaging, which
      // replaces its record.
      if (prior?.status === 'sent' || prior?.status === 'delivered') return replay();
      if (prior?.status === 'failed' || prior?.status === 'bounced') {
        throw new Error(
          `this text was just sent and the carrier reported it ${prior.status}; try again in a minute`,
        );
      }
      return this.textOne(args, message as string);
    }
    // An email row is never replaced: anything but a failed attempt (which
    // never reached the provider) replays, a bounce included.
    if (prior && prior.status !== 'failed') return replay();

    let providerMessageId: string;
    let provider: string;
    try {
      const result = await this.deps.delivery.sendEmail({
        ...(message as EmailMessage),
        tenantId: args.tenantId,
        idempotencyKey,
      });
      providerMessageId = result.providerMessageId;
      provider = result.provider;
    } catch (err) {
      // Audit the failed attempt before propagating, so support has a
      // record of every channel attempt (success or failure). A kill-switch
      // suppression is labelled provider='suppressed', not a transport
      // failure ('unknown').
      await this.deps.dispatchRepo
        .create({
          ...this.emailRecord(args, idempotencyKey),
          provider: err instanceof EmailSuppressedError ? 'suppressed' : 'unknown',
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : 'unknown error',
        })
        .catch(() => {
          // Best-effort audit — never let failure-to-record-failure mask the original error.
        });
      throw err;
    }

    const dispatch = await this.deps.dispatchRepo.create({
      ...this.emailRecord(args, idempotencyKey),
      provider,
      providerMessageId,
      status: 'sent',
    });

    return {
      channel: 'email',
      recipient: args.target.recipient,
      provider,
      providerMessageId,
      dispatchId: dispatch.id,
    };
  }

  private emailRecord(
    args: Parameters<SendService['dispatchOne']>[0],
    idempotencyKey: string,
  ) {
    return {
      tenantId: args.tenantId,
      entityType: args.entityType,
      entityId: args.entityId,
      channel: 'email' as const,
      recipient: args.target.recipient,
      idempotencyKey,
      customerId: args.customerId,
      jobId: args.jobId,
      purpose: args.purpose,
    };
  }

  /**
   * D-045 — a text goes through outbound messaging, which checks consent,
   * holds a reminder until daytime, dedupes, and records the outcome as the
   * message record. Its outcome is turned back into this service's contract:
   * sent resolves; held throws `SmsDeferredError`; refused throws
   * `SmsSuppressedError` (so an 'auto' send falls back to email) or an error
   * saying why.
   */
  private async textOne(
    args: Parameters<SendService['dispatchOne']>[0],
    body: string,
  ): Promise<ChannelSent> {
    const outcome = await this.deps.outbound.sendText({
      tenantId: args.tenantId,
      recipient: { kind: 'customer', customerId: args.customerId, phone: args.target.recipient },
      purpose: args.purpose,
      about: {
        entityType: args.entityType,
        entityId: args.entityId,
        ...(args.jobId ? { jobId: args.jobId } : {}),
      },
      dedupe: args.dedupe,
      body,
    });
    if (outcome.status === 'sent') {
      return {
        channel: 'sms',
        recipient: args.target.recipient,
        provider: outcome.delivery?.provider ?? UNKNOWN_PROVIDER,
        ...(outcome.delivery?.providerMessageId
          ? { providerMessageId: outcome.delivery.providerMessageId }
          : {}),
        ...(outcome.messageId ? { dispatchId: outcome.messageId } : {}),
      };
    }
    if (outcome.status === 'scheduled') throw new SmsDeferredError(outcome.at);
    throw textNotSentError(outcome);
  }
}

/**
 * Every gate refusal, so the compiler flags a reason added later: each one is
 * an `SmsSuppressedError`, which is what lets an 'auto' send fall back to
 * email.
 */
const GATE_REASONS: Record<SmsSuppressionReason, true> = {
  no_consent: true,
  dnc: true,
  missing_consent_context: true,
  revoked: true,
  channel_disabled: true,
  recipient_volume_cap: true,
};

function isGateReason(reason: string): reason is SmsSuppressionReason {
  return Object.prototype.hasOwnProperty.call(GATE_REASONS, reason);
}

/** Another attempt is sending the same text right now. */
export class TextInFlightError extends Error {
  constructor() {
    super('the same text is already being sent');
    this.name = 'TextInFlightError';
  }
}

/** A refused text as the error the send's callers already handle. */
export function textNotSentError(outcome: Extract<RecordedSendOutcome, { status: 'blocked' }>): Error {
  if (isGateReason(outcome.reason)) return new SmsSuppressedError(outcome.reason);
  switch (outcome.reason) {
    case 'in_flight':
      return new TextInFlightError();
    case 'send_failed':
      // The provider's own words are in the message record and the log; the
      // owner sees what kind of failure it was.
      return new DeliveryError(
        outcome.errorCode === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'PROVIDER_FAILED',
        'delivery provider failed',
      );
    case 'lookup_failed':
      return new Error("the customer's texting details couldn't be checked; try again");
    default:
      return new Error(`text not sent: ${outcome.reason.replace(/_/g, ' ')}`);
  }
}

interface ChannelTarget {
  channel: 'sms' | 'email';
  recipient: string;
}

/**
 * D-045 — an invoice is not sent without the pay link its policy calls for.
 * 503: the cause (a settings read, the payment provider) is usually brief, so
 * the owner can try again; the message says what happened and what was not
 * sent.
 */
export class PayLinkUnavailableError extends AppError {
  constructor(invoiceNumber: string, reason: string) {
    super(
      'PAY_LINK_UNAVAILABLE',
      `Invoice ${invoiceNumber} was not sent: its pay link couldn't be made (${reason}). Try again in a moment, or switch to collecting payment on the spot.`,
      503,
    );
    this.name = 'PayLinkUnavailableError';
  }
}

/**
 * Every channel of a send failed. The send has by then written what it is
 * not allowed to lose: each text's message record (blocked, with the reason),
 * and for an invoice its pay link and view token. Owner routes commit with
 * this error (res.locals.forceCommit): a rollback would erase the record the
 * status bubble shows, or leave a live Stripe link no invoice points at.
 */
export class NotDeliveredError extends ValidationError {
  constructor(what: SendSubject, errors: string[]) {
    super(`${what} send failed on all channels: ${errors.join('; ')}`);
    this.name = 'NotDeliveredError';
  }
}

type SendSubject = 'Estimate' | 'Invoice' | 'Portal link';

/**
 * The channels that went out, or the reason none did: every channel held for
 * quiet hours is "not sent yet" (the deferral is rethrown so the caller keeps
 * its work retryable); every channel already being sent by another attempt is
 * a 409, not a failure; anything else is `NotDeliveredError`.
 */
function settleChannels(
  what: SendSubject,
  tried: ChannelTarget[],
  results: PromiseSettledResult<ChannelSent>[],
): ChannelSent[] {
  const sent: ChannelSent[] = [];
  const errors: string[] = [];
  const reasons: unknown[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sent.push(r.value);
    } else {
      reasons.push(r.reason);
      const target = tried[i];
      errors.push(`${target.channel} to ${target.recipient}: ${mapDeliveryErrorForClient(r.reason)}`);
    }
  });
  if (sent.length > 0) return sent;
  if (reasons.every((r) => r instanceof SmsDeferredError)) throw reasons[0];
  if (reasons.every((r) => r instanceof TextInFlightError)) {
    throw new ConflictError(`${what} is already being sent. Check its messages in a moment.`);
  }
  throw new NotDeliveredError(what, errors);
}

type ChannelSent = SendResult['channelsSent'][number];

/**
 * D-045 — a send with no channel named goes by text first and falls back to
 * email: when that text is refused (no consent, opted out, do-not-contact, a
 * cap, texting switched off) and an email is on file, the email goes instead.
 * A text held for quiet hours is not refused, so it does not fall back.
 */
async function withEmailFallback(args: {
  channel: SendChannel;
  email: string | undefined;
  channels: ChannelTarget[];
  results: PromiseSettledResult<ChannelSent>[];
  dispatch: (target: ChannelTarget) => Promise<ChannelSent>;
}): Promise<{ tried: ChannelTarget[]; results: PromiseSettledResult<ChannelSent>[] }> {
  const unchanged = { tried: args.channels, results: args.results };
  if (args.channel !== 'auto' || args.channels.length !== 1 || args.channels[0].channel !== 'sms') {
    return unchanged;
  }
  const [only] = args.results;
  if (only.status !== 'rejected' || !(only.reason instanceof SmsSuppressedError)) return unchanged;
  const email = args.email?.trim();
  if (!email) return unchanged;
  const target: ChannelTarget = { channel: 'email', recipient: email };
  const [emailResult] = await Promise.allSettled([args.dispatch(target)]);
  return { tried: [...args.channels, target], results: [...args.results, emailResult] };
}

function resolveChannels(args: {
  channel: SendChannel;
  customer: Parameters<typeof defaultSendChannel>[0];
  recipientPhone?: string;
  recipientEmail?: string;
}): ChannelTarget[] {
  const targets: ChannelTarget[] = [];
  if (args.channel === 'auto') {
    const picked = defaultSendChannel(args.customer);
    if (!picked) {
      throw new ValidationError(
        'Cannot send — the customer has no email or phone number on file'
      );
    }
    return resolveChannels({ ...args, channel: picked });
  }
  const wantSms = args.channel === 'sms' || args.channel === 'both';
  const wantEmail = args.channel === 'email' || args.channel === 'both';

  if (wantSms) {
    // A blank override is no override: the text, its record and the result
    // all name the number on file.
    const phone = args.recipientPhone?.trim() || args.customer.primaryPhone;
    if (!phone) {
      throw new ValidationError(
        'Cannot send SMS — no phone number provided and customer has no primary phone'
      );
    }
    targets.push({ channel: 'sms', recipient: phone });
  }
  if (wantEmail) {
    const email = args.recipientEmail?.trim() || args.customer.email;
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

/** The newest channel's message record (a channel whose record write failed has none). */
function latestDispatchId(sent: SendResult['channelsSent']): string | undefined {
  return sent.flatMap((c) => (c.dispatchId ? [c.dispatchId] : [])).pop();
}
