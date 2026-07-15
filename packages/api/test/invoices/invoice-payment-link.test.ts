import { describe, expect, it } from 'vitest';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { MockPaymentLinkProvider } from '../../src/payments/payment-link-provider';
import { createInvoicePaymentLink } from '../../src/invoices/invoice-payment-link';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('createInvoicePaymentLink (INV-04)', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const jobId = '00000000-0000-4000-8000-000000000002';

  it('returns existing url when stripePaymentLinkUrl is set', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000010',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0001',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 5000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 5000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 5000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      stripePaymentLinkUrl: 'https://checkout.stripe.com/c/pay/existing',
    });

    const provider = new MockPaymentLinkProvider();
    const result = await createInvoicePaymentLink(tenantId, invoice.id, repo, provider);
    expect(result.url).toBe('https://checkout.stripe.com/c/pay/existing');
  });

  it('mints link and persists url for open invoice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000011',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0002',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 8000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 8000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 8000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const provider = new MockPaymentLinkProvider();
    const result = await createInvoicePaymentLink(tenantId, invoice.id, repo, provider);
    expect(result.url).toMatch(/^https:\/\/pay\.mock\.com\//);

    const updated = await repo.findById(tenantId, invoice.id);
    expect(updated?.stripePaymentLinkUrl).toBe(result.url);
  });

  it('passes stripeAccountId to the provider when Connect charges are enabled', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000013',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0004',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 2000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 2000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 2000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const seen: Array<{ stripeAccountId?: string }> = [];
    const provider = {
      generateLink: async (req: { stripeAccountId?: string }) => {
        seen.push({ stripeAccountId: req.stripeAccountId });
        return {
          linkId: 'plink_1',
          linkUrl: 'https://pay.mock.com/plink_1',
          providerReference: 'mock_plink_1',
        };
      },
      deactivateLink: async () => undefined,
    };

    await createInvoicePaymentLink(tenantId, invoice.id, repo, provider, {
      resolveTenantConnectAccount: async () => ({
        accountId: 'acct_op_link',
        chargesEnabled: true,
      }),
    });

    expect(seen[0]?.stripeAccountId).toBe('acct_op_link');
  });

  it('rejects draft invoice with 409-class error', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000012',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0003',
      status: 'draft',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 1000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 1000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 1000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const provider = new MockPaymentLinkProvider();
    await expect(
      createInvoicePaymentLink(tenantId, invoice.id, repo, provider),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
