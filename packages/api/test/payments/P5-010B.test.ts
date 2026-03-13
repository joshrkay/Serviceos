import {
  MockPaymentLinkProvider,
  validatePaymentLinkRequest,
  PaymentLinkRequest,
} from '../../src/payments/payment-link-provider';

describe('P5-010B: Payment-link generation contract placeholder', () => {
  let provider: MockPaymentLinkProvider;

  const validRequest: PaymentLinkRequest = {
    tenantId: 'tenant-1',
    invoiceId: 'inv-001',
    amountCents: 5000,
    currency: 'USD',
    customerEmail: 'test@example.com',
    description: 'Test payment',
  };

  beforeEach(() => {
    provider = new MockPaymentLinkProvider();
  });

  describe('Happy path: generates link with URL, ID, expiration', () => {
    it('should generate a payment link with all expected fields', async () => {
      const result = await provider.generateLink(validRequest);

      expect(result.linkId).toBeDefined();
      expect(typeof result.linkId).toBe('string');
      expect(result.linkUrl).toContain('https://');
      expect(result.linkUrl).toContain(result.linkId);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(result.providerReference).toBeDefined();
    });
  });

  describe('Validation: missing fields, zero/negative amount, non-integer amount', () => {
    it('should return error for missing tenantId', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, tenantId: '' });
      expect(errors).toContain('tenantId is required');
    });

    it('should return error for missing invoiceId', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, invoiceId: '' });
      expect(errors).toContain('invoiceId is required');
    });

    it('should return error for missing currency', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, currency: '' });
      expect(errors).toContain('currency is required');
    });

    it('should return error for negative amount', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, amountCents: -100 });
      expect(errors).toContain('amountCents must be positive');
    });

    it('should return error for non-integer amount', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, amountCents: 10.5 });
      expect(errors).toContain('amountCents must be an integer');
    });

    it('should return no errors for a valid request', () => {
      const errors = validatePaymentLinkRequest(validRequest);
      expect(errors).toHaveLength(0);
    });
  });

  describe('Tenant isolation: request requires tenantId', () => {
    it('should reject request without tenantId', async () => {
      await expect(
        provider.generateLink({ ...validRequest, tenantId: '' })
      ).rejects.toThrow('tenantId is required');
    });
  });

  describe('Zero amount edge case: rejected', () => {
    it('should reject zero amountCents', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, amountCents: 0 });
      expect(errors).toContain('amountCents must be positive');
    });

    it('should throw when generating link with zero amount', async () => {
      await expect(
        provider.generateLink({ ...validRequest, amountCents: 0 })
      ).rejects.toThrow('amountCents must be positive');
    });
  });

  describe('Rounding boundary: smallest valid amount', () => {
    it('should accept 1 cent as valid amountCents', () => {
      const errors = validatePaymentLinkRequest({ ...validRequest, amountCents: 1 });
      expect(errors).toHaveLength(0);
    });

    it('should generate link for 1 cent amount', async () => {
      const result = await provider.generateLink({ ...validRequest, amountCents: 1 });
      expect(result.linkId).toBeDefined();
      expect(result.linkUrl).toContain('https://');
    });
  });

  describe('Deactivate link works', () => {
    it('should deactivate an active link', async () => {
      const result = await provider.generateLink(validRequest);
      expect(provider.isActive(result.linkId)).toBe(true);

      await provider.deactivateLink(result.linkId);
      expect(provider.isActive(result.linkId)).toBe(false);
    });

    it('should handle deactivating a non-existent link gracefully', async () => {
      await expect(provider.deactivateLink('non-existent')).resolves.toBeUndefined();
    });
  });

  describe('Mock provider returns expected shape', () => {
    it('should return result matching PaymentLinkResult interface', async () => {
      const result = await provider.generateLink(validRequest);

      expect(result).toHaveProperty('linkId');
      expect(result).toHaveProperty('linkUrl');
      expect(result).toHaveProperty('expiresAt');
      expect(result).toHaveProperty('providerReference');
      expect(result.providerReference).toMatch(/^mock_/);
    });
  });
});
