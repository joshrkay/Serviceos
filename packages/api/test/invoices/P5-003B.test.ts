import {
  validateInvoiceProposal,
  coerceNumericFields,
} from '../../src/invoices/invoice-proposal-validator';

const validPayload = {
  customerId: '00000000-0000-0000-0000-000000000001',
  jobId: '00000000-0000-0000-0000-000000000002',
  lineItems: [
    { description: 'AC Repair', quantity: 2, unitPrice: 7500, category: 'labor' },
    { description: 'Air filter', quantity: 1, unitPrice: 3000 },
  ],
  discountCents: 500,
  taxRateBps: 825,
  customerMessage: 'Thank you for your business',
  internalNotes: 'Rush job',
};

describe('P5-003B — Invoice proposal schema validation', () => {
  describe('validateInvoiceProposal', () => {
    it('happy path — valid payload passes', () => {
      const result = validateInvoiceProposal(validPayload);
      expect(result.valid).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.payload!.customerId).toBe(validPayload.customerId);
      expect(result.payload!.jobId).toBe(validPayload.jobId);
      expect(result.payload!.lineItems).toHaveLength(2);
      expect(result.errors).toBeUndefined();
    });

    it('happy path — minimal valid payload passes', () => {
      const minimal = {
        customerId: '00000000-0000-0000-0000-000000000001',
        jobId: '00000000-0000-0000-0000-000000000002',
        lineItems: [{ description: 'Service', quantity: 1, unitPrice: 1000 }],
      };
      const result = validateInvoiceProposal(minimal);
      expect(result.valid).toBe(true);
      expect(result.payload).toBeDefined();
    });

    it('happy path — payload with all optional fields', () => {
      const result = validateInvoiceProposal({
        ...validPayload,
        estimateId: '00000000-0000-0000-0000-000000000003',
        invoiceNumber: 'INV-001',
      });
      expect(result.valid).toBe(true);
    });

    it('validation — missing customerId rejected', () => {
      const { customerId, ...rest } = validPayload;
      const result = validateInvoiceProposal(rest);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes('customerId'))).toBe(true);
    });

    it('validation — missing jobId rejected', () => {
      const { jobId, ...rest } = validPayload;
      const result = validateInvoiceProposal(rest);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes('jobId'))).toBe(true);
    });

    it('validation — missing lineItems rejected', () => {
      const { lineItems, ...rest } = validPayload;
      const result = validateInvoiceProposal(rest);
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes('lineItems'))).toBe(true);
    });

    it('validation — empty lineItems rejected', () => {
      const result = validateInvoiceProposal({ ...validPayload, lineItems: [] });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes('lineItems'))).toBe(true);
    });

    it('validation — invalid customerId UUID rejected', () => {
      const result = validateInvoiceProposal({ ...validPayload, customerId: 'not-a-uuid' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes('customerId'))).toBe(true);
    });

    it('validation — invalid jobId UUID rejected', () => {
      const result = validateInvoiceProposal({ ...validPayload, jobId: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.includes('jobId'))).toBe(true);
    });

    it('validation — negative discountCents rejected', () => {
      const result = validateInvoiceProposal({ ...validPayload, discountCents: -100 });
      expect(result.valid).toBe(false);
    });

    it('validation — taxRateBps over 10000 rejected', () => {
      const result = validateInvoiceProposal({ ...validPayload, taxRateBps: 15000 });
      expect(result.valid).toBe(false);
    });

    it('validation — line item missing description rejected', () => {
      const result = validateInvoiceProposal({
        ...validPayload,
        lineItems: [{ quantity: 1, unitPrice: 1000 }],
      });
      expect(result.valid).toBe(false);
    });

    it('malformed — null input rejected', () => {
      const result = validateInvoiceProposal(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Input must be a non-null object');
    });

    it('malformed — undefined input rejected', () => {
      const result = validateInvoiceProposal(undefined);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Input must be a non-null object');
    });

    it('malformed — string input rejected', () => {
      const result = validateInvoiceProposal('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Input must be a non-null object');
    });

    it('malformed — array input rejected', () => {
      const result = validateInvoiceProposal([1, 2, 3]);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('malformed — empty object rejected', () => {
      const result = validateInvoiceProposal({});
      expect(result.valid).toBe(false);
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('coerceNumericFields', () => {
    it('coerces string discountCents to number', () => {
      const result = coerceNumericFields({ discountCents: '500' } as unknown as Record<string, unknown>);
      expect(result.discountCents).toBe(500);
    });

    it('coerces string taxRateBps to number', () => {
      const result = coerceNumericFields({ taxRateBps: '825' } as unknown as Record<string, unknown>);
      expect(result.taxRateBps).toBe(825);
    });

    it('coerces string quantity in lineItems to number', () => {
      const result = coerceNumericFields({
        lineItems: [{ description: 'Test', quantity: '2', unitPrice: 1000 }],
      } as unknown as Record<string, unknown>);
      const items = result.lineItems as Array<Record<string, unknown>>;
      expect(items[0].quantity).toBe(2);
    });

    it('coerces string unitPrice in lineItems to number', () => {
      const result = coerceNumericFields({
        lineItems: [{ description: 'Test', quantity: 1, unitPrice: '7500' }],
      } as unknown as Record<string, unknown>);
      const items = result.lineItems as Array<Record<string, unknown>>;
      expect(items[0].unitPrice).toBe(7500);
    });

    it('leaves valid numbers unchanged', () => {
      const result = coerceNumericFields({
        discountCents: 500,
        taxRateBps: 825,
      } as unknown as Record<string, unknown>);
      expect(result.discountCents).toBe(500);
      expect(result.taxRateBps).toBe(825);
    });

    it('does not coerce non-numeric strings', () => {
      const result = coerceNumericFields({
        discountCents: 'abc',
        taxRateBps: 'xyz',
      } as unknown as Record<string, unknown>);
      expect(result.discountCents).toBe('abc');
      expect(result.taxRateBps).toBe('xyz');
    });

    it('handles missing lineItems gracefully', () => {
      const result = coerceNumericFields({ customerId: 'test' } as unknown as Record<string, unknown>);
      expect(result.lineItems).toBeUndefined();
    });

    it('handles null items in lineItems array', () => {
      const result = coerceNumericFields({
        lineItems: [null, { description: 'Test', quantity: '1', unitPrice: 1000 }],
      } as unknown as Record<string, unknown>);
      const items = result.lineItems as Array<unknown>;
      expect(items[0]).toBeNull();
    });

    it('coercion enables previously invalid string-number payload to pass validation', () => {
      const stringified = {
        customerId: '00000000-0000-0000-0000-000000000001',
        jobId: '00000000-0000-0000-0000-000000000002',
        lineItems: [{ description: 'Service', quantity: '1', unitPrice: '5000' }],
        discountCents: '200',
        taxRateBps: '825',
      };
      const result = validateInvoiceProposal(stringified);
      expect(result.valid).toBe(true);
      expect(result.payload!.lineItems[0].quantity).toBe(1);
      expect(result.payload!.discountCents).toBe(200);
    });
  });
});
