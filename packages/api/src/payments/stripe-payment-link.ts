import { PaymentLinkProvider, PaymentLinkRequest, PaymentLinkResult, validatePaymentLinkRequest } from './payment-link-provider';

export interface StripeConfig {
  apiKey: string;
  webhookSecret: string;
}

// fetch has NO default timeout: a stalled Stripe upstream would otherwise pin
// the calling request (portal payment-link generation) until TCP gives up.
const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

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
    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Invoice ${request.invoiceId}`,
        'line_items[0][price_data][unit_amount]': String(request.amountCents),
        'line_items[0][quantity]': '1',
        'metadata[tenant_id]': request.tenantId,
        'metadata[invoice_id]': request.invoiceId,
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

  async deactivateLink(linkId: string): Promise<void> {
    const res = await fetch(`https://api.stripe.com/v1/payment_links/${linkId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ active: 'false' }),
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe deactivation failed (${res.status}): ${body}`);
    }
  }
}
