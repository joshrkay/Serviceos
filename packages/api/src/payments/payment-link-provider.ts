import { v4 as uuidv4 } from 'uuid';

export interface PaymentLinkRequest {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  customerEmail?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentLinkResult {
  linkId: string;
  linkUrl: string;
  expiresAt?: Date;
  providerReference: string;
}

export interface PaymentLinkProvider {
  generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult>;
  deactivateLink(linkId: string): Promise<void>;
}

export function validatePaymentLinkRequest(request: PaymentLinkRequest): string[] {
  const errors: string[] = [];
  if (!request.tenantId) errors.push('tenantId is required');
  if (!request.invoiceId) errors.push('invoiceId is required');
  if (!request.amountCents || request.amountCents <= 0) errors.push('amountCents must be positive');
  if (!Number.isInteger(request.amountCents)) errors.push('amountCents must be an integer');
  if (!request.currency) errors.push('currency is required');
  return errors;
}

// Mock provider for testing
export class MockPaymentLinkProvider implements PaymentLinkProvider {
  private links: Map<string, PaymentLinkResult & { active: boolean }> = new Map();

  async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    const errors = validatePaymentLinkRequest(request);
    if (errors.length > 0) throw new Error(`Invalid request: ${errors.join(', ')}`);

    const linkId = uuidv4();
    const result: PaymentLinkResult = {
      linkId,
      linkUrl: `https://pay.mock.com/${linkId}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      providerReference: `mock_${linkId}`,
    };

    this.links.set(linkId, { ...result, active: true });
    return result;
  }

  async deactivateLink(linkId: string): Promise<void> {
    const link = this.links.get(linkId);
    if (link) link.active = false;
  }

  isActive(linkId: string): boolean {
    return this.links.get(linkId)?.active ?? false;
  }
}
