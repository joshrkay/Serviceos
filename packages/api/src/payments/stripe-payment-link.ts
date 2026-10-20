import { createLogger } from '../logging/logger';
import {
  DeactivateLinkOptions,
  InvoicePaymentIntentSummary,
  PaymentLinkProvider,
  PaymentLinkRequest,
  PaymentLinkResult,
  validatePaymentLinkRequest,
} from './payment-link-provider';
import {
  cancelPaymentIntent,
  searchPaymentIntentsByInvoice,
  StripeFetch,
} from './stripe-payment-intent';

export interface StripeConfig {
  apiKey: string;
  webhookSecret: string;
}

// fetch has NO default timeout: a stalled Stripe upstream would otherwise pin
// the calling request (portal payment-link generation) until TCP gives up.
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

const logger = createLogger({
  service: 'stripe-payment-link',
  environment: process.env.NODE_ENV || 'dev',
});

export class StripePaymentLinkProvider implements PaymentLinkProvider {
  private readonly config: StripeConfig;

  constructor(config: StripeConfig) {
    if (!config.apiKey) {
      throw new Error('StripePaymentLinkProvider requires a Stripe API key. Set STRIPE_API_KEY in environment.');
    }
    this.config = config;
  }

  async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    const errors = validatePaymentLinkRequest(request);
    if (errors.length > 0) throw new Error(`Invalid request: ${errors.join(', ')}`);

    // Idempotency lives at the caller: routes/public-portal.ts gates on
    // invoice.stripePaymentLinkUrl before calling generateLink, and persists
    // the returned linkId/linkUrl back onto the invoice. The provider stays
    // stateless so a restart can't desync from the durable invoice row.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (request.stripeAccountId?.trim()) {
      headers['Stripe-Account'] = request.stripeAccountId.trim();
    }

    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Invoice ${request.invoiceId}`,
        'line_items[0][price_data][unit_amount]': String(request.amountCents),
        'line_items[0][quantity]': '1',
        'metadata[tenant_id]': request.tenantId,
        'metadata[invoice_id]': request.invoiceId,
        // Single completed checkout only — Stripe itself refuses a 2nd paid
        // session on this link, so a replayed/saved link can't double-charge a
        // card after the invoice is already settled (the webhook would silently
        // drop the 2nd charge as "already settled").
        'restrictions[completed_sessions][limit]': '1',
      }),
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe API error (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { id: string; url: string };
    const linkId = data.id;
    const linkUrl = data.url;
    const now = new Date();
    // Default to 24h. Guard against missing / non-numeric / non-positive
    // values — without this an invalid env var produces NaN ms and
    // `expiresAt` becomes Invalid Date.
    const parsedHours = parseInt(process.env.PAYMENT_LINK_EXPIRY_HOURS ?? '', 10);
    const hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : 24;
    const expiryMs = hours * 60 * 60 * 1000;

    return {
      linkId,
      linkUrl,
      expiresAt: new Date(now.getTime() + expiryMs),
      providerReference: `stripe_${linkId}`,
    };
  }

  async deactivateLink(
    linkId: string,
    stripeAccountId?: string,
    options?: DeactivateLinkOptions,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (stripeAccountId?.trim()) {
      headers['Stripe-Account'] = stripeAccountId.trim();
    }
    const post = (form: Record<string, string>) =>
      fetch(`https://api.stripe.com/v1/payment_links/${linkId}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
      });

    // S5a-3 (U8) — the inactive message rides in the SAME update as
    // active=false, so the link never dies without its explanation. The calls
    // pin no Stripe API version (account default): if the account's version
    // refuses the field, retry ONCE without it (owner decision §5.3) — killing
    // the link matters more than its hosted page's wording.
    const message = options?.inactiveMessage?.trim();
    let res = await post(message ? { active: 'false', inactive_message: message } : { active: 'false' });
    if (!res.ok && message && res.status === 400) {
      const body = await res.text();
      if (!body.includes('inactive_message')) {
        throw new Error(`Stripe deactivation failed (${res.status}): ${body}`);
      }
      logger.warn('Stripe refused inactive_message; deactivating the payment link without it', {
        linkId,
        status: res.status,
      });
      res = await post({ active: 'false' });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe deactivation failed (${res.status}): ${body}`);
    }
  }

  // P0-1 completion — the wrappers in stripe-payment-intent.ts take an
  // injectable fetcher without a timeout; wrap global fetch so these calls
  // share the same stalled-upstream guard as the link calls above.
  private readonly timedFetch: StripeFetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS) });

  /** Discover PIs minted for an invoice (metadata-stamped at mint) in one
   * account scope. See searchPaymentIntentsByInvoice for the mechanism. */
  async listInvoicePaymentIntents(
    tenantId: string,
    invoiceId: string,
    stripeAccountId?: string,
  ): Promise<InvoicePaymentIntentSummary[]> {
    return searchPaymentIntentsByInvoice(
      { apiKey: this.config.apiKey },
      { tenantId, invoiceId, ...(stripeAccountId?.trim() ? { stripeAccountId } : {}) },
      this.timedFetch,
    );
  }

  /** Cancel a minted PI so its client secret can no longer capture money. */
  async cancelPaymentIntent(paymentIntentId: string, stripeAccountId?: string): Promise<void> {
    await cancelPaymentIntent(
      { apiKey: this.config.apiKey },
      paymentIntentId,
      stripeAccountId?.trim() || undefined,
      this.timedFetch,
    );
  }
}
