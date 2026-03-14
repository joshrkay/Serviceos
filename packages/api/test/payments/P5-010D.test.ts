import { StripePaymentLinkProvider, StripeConfig } from '../../src/payments/stripe-payment-link';
import { PaymentLinkRequest } from '../../src/payments/payment-link-provider';
import {
  InMemoryPaymentReadinessRepository,
  createPaymentReadiness,
} from '../../src/invoices/payment-readiness';

describe('P5-010D: Generate Stripe payment link after invoice approval', () => {
  let readinessRepo: InMemoryPaymentReadinessRepository;
  let provider: StripePaymentLinkProvider;
  const config: StripeConfig = {
    apiKey: 'sk_test_fake',
    webhookSecret: 'whsec_test_fake',
  };

  const validRequest: PaymentLinkRequest = {
    tenantId: 'tenant-1',
    invoiceId: 'inv-001',
    amountCents: 5000,
    currency: 'USD',
    customerEmail: 'test@example.com',
    description: 'Invoice #INV-001',
  };

  beforeEach(async () => {
    readinessRepo = new InMemoryPaymentReadinessRepository();
    provider = new StripePaymentLinkProvider(config, readinessRepo);
    // Pre-create a readiness record for the invoice
    await createPaymentReadiness('tenant-1', 'inv-001', true, readinessRepo);
  });

  describe('Happy path: generates link with URL and stores in readiness', () => {
    it('should generate a Stripe payment link with all expected fields', async () => {
      const result = await provider.generateLink(validRequest);

      expect(result.linkId).toBeDefined();
      expect(result.linkUrl).toContain('https://checkout.stripe.com/pay/');
      expect(result.linkUrl).toContain(result.linkId);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(result.providerReference).toMatch(/^stripe_plink_/);
    });

    it('should update readiness record with link details', async () => {
      const result = await provider.generateLink(validRequest);

      const readiness = await readinessRepo.findByInvoice('tenant-1', 'inv-001');
      expect(readiness).not.toBeNull();
      expect(readiness!.paymentLinkStatus).toBe('active');
      expect(readiness!.paymentLinkId).toBe(result.linkId);
      expect(readiness!.paymentLinkUrl).toBe(result.linkUrl);
      expect(readiness!.paymentLinkCreatedAt).toBeInstanceOf(Date);
    });
  });

  describe('Validation: invalid request rejected', () => {
    it('should reject request with missing tenantId', async () => {
      await expect(
        provider.generateLink({ ...validRequest, tenantId: '' })
      ).rejects.toThrow('tenantId is required');
    });

    it('should reject request with missing invoiceId', async () => {
      await expect(
        provider.generateLink({ ...validRequest, invoiceId: '' })
      ).rejects.toThrow('invoiceId is required');
    });

    it('should reject request with missing currency', async () => {
      await expect(
        provider.generateLink({ ...validRequest, currency: '' })
      ).rejects.toThrow('currency is required');
    });
  });

  describe('Tenant isolation: readiness repo scoped by tenant', () => {
    it('should not find readiness record for different tenant', async () => {
      await provider.generateLink(validRequest);

      const readiness = await readinessRepo.findByInvoice('tenant-other', 'inv-001');
      expect(readiness).toBeNull();
    });

    it('should reject request without tenantId', async () => {
      await expect(
        provider.generateLink({ ...validRequest, tenantId: '' })
      ).rejects.toThrow('tenantId is required');
    });
  });

  describe('Zero amount: rejected by validation', () => {
    it('should reject zero amountCents', async () => {
      await expect(
        provider.generateLink({ ...validRequest, amountCents: 0 })
      ).rejects.toThrow('amountCents must be positive');
    });

    it('should reject negative amountCents', async () => {
      await expect(
        provider.generateLink({ ...validRequest, amountCents: -100 })
      ).rejects.toThrow('amountCents must be positive');
    });
  });

  describe('Rounding boundary: smallest valid amount', () => {
    it('should generate link for 1 cent amount', async () => {
      const result = await provider.generateLink({ ...validRequest, amountCents: 1 });
      expect(result.linkId).toBeDefined();
      expect(result.linkUrl).toContain('https://checkout.stripe.com/pay/');
    });
  });

  describe('Idempotency: returns existing active link', () => {
    it('should return the same link on repeated calls', async () => {
      const first = await provider.generateLink(validRequest);
      const second = await provider.generateLink(validRequest);

      expect(second.linkId).toBe(first.linkId);
      expect(second.linkUrl).toBe(first.linkUrl);
      expect(second.providerReference).toBe(first.providerReference);
    });
  });

  describe('Link format: starts with expected prefix', () => {
    it('should have linkId starting with plink_', async () => {
      const result = await provider.generateLink(validRequest);
      expect(result.linkId).toMatch(/^plink_/);
    });

    it('should have linkUrl starting with https://checkout.stripe.com/pay/', async () => {
      const result = await provider.generateLink(validRequest);
      expect(result.linkUrl).toMatch(/^https:\/\/checkout\.stripe\.com\/pay\/plink_/);
    });

    it('should have providerReference starting with stripe_', async () => {
      const result = await provider.generateLink(validRequest);
      expect(result.providerReference).toMatch(/^stripe_/);
    });
  });
});
