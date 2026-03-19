import { PaymentLinkProvider, PaymentLinkRequest, PaymentLinkResult, validatePaymentLinkRequest } from './payment-link-provider';
import { PaymentReadinessRepository } from '../invoices/payment-readiness';

export interface StripeConfig {
  apiKey: string;
  webhookSecret: string;
}

export class StripePaymentLinkProvider implements PaymentLinkProvider {
  private readonly config: StripeConfig;
  private readonly readinessRepo: PaymentReadinessRepository;

  constructor(config: StripeConfig, readinessRepo: PaymentReadinessRepository) {
    this.config = config;

    if (!config.apiKey) {
      throw new Error('StripePaymentLinkProvider requires a Stripe API key. Set STRIPE_API_KEY in environment.');
    }

    this.readinessRepo = readinessRepo;
  }

  async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    const errors = validatePaymentLinkRequest(request);
    if (errors.length > 0) throw new Error(`Invalid request: ${errors.join(', ')}`);

    // Check idempotency - if active link already exists, return it
    const existing = await this.readinessRepo.findByInvoice(request.tenantId, request.invoiceId);
    if (existing && existing.paymentLinkStatus === 'active' && existing.paymentLinkId && existing.paymentLinkUrl) {
      return {
        linkId: existing.paymentLinkId,
        linkUrl: existing.paymentLinkUrl,
        providerReference: `stripe_${existing.paymentLinkId}`,
      };
    }

    // Call Stripe API to create a payment link
    // Uses the Stripe REST API directly to avoid adding the stripe SDK dependency.
    // When ready, replace with: const stripe = new Stripe(this.config.apiKey);
    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Invoice ${request.invoiceNumber ?? request.invoiceId}`,
        'line_items[0][price_data][unit_amount]': String(request.amountCents),
        'line_items[0][quantity]': '1',
        'metadata[tenant_id]': request.tenantId,
        'metadata[invoice_id]': request.invoiceId,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe API error (${res.status}): ${body}`);
    }

    const data = await res.json();
    const linkId = data.id as string;
    const linkUrl = data.url as string;
    const now = new Date();
    const expiryMs = parseInt(process.env.PAYMENT_LINK_EXPIRY_HOURS || '24', 10) * 60 * 60 * 1000;

    const result: PaymentLinkResult = {
      linkId,
      linkUrl,
      expiresAt: new Date(now.getTime() + expiryMs),
      providerReference: `stripe_${linkId}`,
    };

    // Update readiness record
    await this.readinessRepo.update(request.tenantId, request.invoiceId, {
      paymentLinkStatus: 'active',
      paymentLinkId: linkId,
      paymentLinkUrl: linkUrl,
      paymentLinkCreatedAt: now,
    });

    return result;
  }

  async deactivateLink(linkId: string): Promise<void> {
    // Stripe payment links can be deactivated via the API
    const res = await fetch(`https://api.stripe.com/v1/payment_links/${linkId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ active: 'false' }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe deactivation failed (${res.status}): ${body}`);
    }
  }
}
