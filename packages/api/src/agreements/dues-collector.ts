/**
 * #6 phase 4 — membership dues auto-collection.
 *
 * For a membership with `auto_collect_dues` and a default saved card, the
 * recurring sweep charges the cycle's dues off-session instead of leaving a
 * draft invoice for manual payment. The invoice is ISSUED before the charge so
 * that a decline / authentication-required still leaves the customer a payable
 * invoice (dunning) — dues are never silently dropped. Money math + the actual
 * charge live in the shared Stripe wrapper; this orchestrates resolve → issue →
 * charge → record.
 */
import { CustomerPaymentMethodRepository } from '../payments/customer-payment-method';
import { chargeOffSession, StripeAccountConfig } from '../payments/stripe-saved-card';
import { StripeFetch } from '../payments/stripe-payment-intent';
import { ConnectAccountResolver } from '../invoices/public-invoice-service';

export interface DuesCollectionInput {
  tenantId: string;
  customerId: string;
  invoiceId: string;
  agreementId: string;
  /** The run's scheduled date — part of the idempotency key. */
  scheduledFor: string;
  createdBy: string;
}

export type DuesCollectionStatus =
  | 'collected'
  /**
   * The card WAS charged but recording the payment failed — money moved, our
   * books didn't. A distinct, loud state (never folded into 'failed') carrying
   * the PaymentIntent id so it can be reconciled and is never re-charged.
   */
  | 'collected_unrecorded'
  | 'no_card'
  | 'requires_action'
  | 'failed';

export interface DuesCollectionResult {
  status: DuesCollectionStatus;
  paymentIntentId?: string;
  declineCode?: string;
  /** Set when status is collected_unrecorded — the recordPayment error. */
  recordError?: string;
}

export interface DuesCollector {
  collect(input: DuesCollectionInput): Promise<DuesCollectionResult>;
}

/**
 * Invoice operations the collector needs, kept as a port so the agreement
 * layer doesn't import the invoice/payment machinery directly (and tests can
 * mock it): issue the draft dues invoice (if needed) and return the authoritative
 * amount it owes — we charge THAT, not the raw agreement price, so the charge,
 * the invoice total, and the recorded payment can never disagree — and record a
 * successful off-session charge as a payment.
 */
export interface DuesInvoiceOps {
  ensureIssuedAmountDue(tenantId: string, invoiceId: string): Promise<number>;
  recordPayment(input: {
    tenantId: string;
    invoiceId: string;
    amountCents: number;
    providerReference: string;
    createdBy: string;
  }): Promise<void>;
}

export interface StripeDuesCollectorDeps {
  customerPaymentMethodRepo: CustomerPaymentMethodRepository;
  stripeConfig: { apiKey: string };
  invoiceOps: DuesInvoiceOps;
  connectAccountResolver?: ConnectAccountResolver;
  currency?: string;
  stripeFetch?: StripeFetch;
}

export class StripeDuesCollector implements DuesCollector {
  constructor(private readonly deps: StripeDuesCollectorDeps) {}

  async collect(input: DuesCollectionInput): Promise<DuesCollectionResult> {
    const card = await this.deps.customerPaymentMethodRepo.findDefaultForCustomer(
      input.tenantId,
      input.customerId,
    );
    if (!card) return { status: 'no_card' };

    // Issue first so a decline still leaves a payable invoice (not a hidden
    // draft), and charge exactly what the issued invoice owes.
    const amountDueCents = await this.deps.invoiceOps.ensureIssuedAmountDue(
      input.tenantId,
      input.invoiceId,
    );
    if (amountDueCents <= 0) return { status: 'collected' }; // nothing owed

    const connect = this.deps.connectAccountResolver
      ? await this.deps.connectAccountResolver
          .resolveTenantConnectAccount(input.tenantId)
          .catch(() => null)
      : null;
    const config: StripeAccountConfig = {
      apiKey: this.deps.stripeConfig.apiKey,
      stripeAccountId: connect && connect.chargesEnabled ? connect.accountId : undefined,
    };

    const result = await chargeOffSession(
      config,
      {
        amount: amountDueCents,
        currency: this.deps.currency ?? 'usd',
        stripeCustomerId: card.stripeCustomerId,
        paymentMethodId: card.stripePaymentMethodId,
        // Stable per cycle so a re-run of the sweep can't double-charge.
        idempotencyKey: `agreement_${input.agreementId}_${input.scheduledFor}`,
        metadata: {
          invoice_id: input.invoiceId,
          tenant_id: input.tenantId,
          agreement_id: input.agreementId,
        },
      },
      this.deps.stripeFetch,
    );

    if (result.status === 'succeeded' && result.paymentIntentId) {
      try {
        await this.deps.invoiceOps.recordPayment({
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          amountCents: amountDueCents,
          providerReference: result.paymentIntentId,
          createdBy: input.createdBy,
        });
      } catch (recordErr) {
        // Stripe captured the money but we failed to record it. Never report
        // this as a plain failure (it would hide a real charge and could be
        // re-attempted): surface it distinctly with the PaymentIntent id.
        return {
          status: 'collected_unrecorded',
          paymentIntentId: result.paymentIntentId,
          recordError: recordErr instanceof Error ? recordErr.message : String(recordErr),
        };
      }
      return { status: 'collected', paymentIntentId: result.paymentIntentId };
    }

    return {
      status: result.status === 'requires_action' ? 'requires_action' : 'failed',
      paymentIntentId: result.paymentIntentId,
      declineCode: result.declineCode,
    };
  }
}
