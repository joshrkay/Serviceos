import { v4 as uuidv4 } from 'uuid';
import { PaymentLinkProvider, PaymentLinkRequest, PaymentLinkResult, validatePaymentLinkRequest } from './payment-link-provider';
import { PaymentReadiness, PaymentReadinessRepository } from '../invoices/payment-readiness';

export interface StripeConfig {
  apiKey: string;
  webhookSecret: string;
}

export class StripePaymentLinkProvider implements PaymentLinkProvider {
  private readonly config: StripeConfig;
  private readonly readinessRepo: PaymentReadinessRepository;

  constructor(config: StripeConfig, readinessRepo: PaymentReadinessRepository) {
    this.config = config;
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

    // In production, this would call Stripe API
    // For now, generate a mock Stripe link
    const linkId = `plink_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
    const linkUrl = `https://checkout.stripe.com/pay/${linkId}`;
    const now = new Date();

    const result: PaymentLinkResult = {
      linkId,
      linkUrl,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
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
    // In production, would call Stripe to deactivate
  }
}
