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

  // U9 invariant (absent side): the operator link must NOT route to Connect
  // unless charges are enabled — otherwise a half-onboarded tenant's operator
  // link would 500 (Connect account can't accept charges) or, worse, a stale
  // account id would misroute funds. Mirrors the platform-fallback guard the
  // public invoice link already proves in public-invoice-connect.test.ts.
  async function seenAccountFor(
    resolver: Parameters<typeof createInvoicePaymentLink>[4],
  ): Promise<string | undefined> {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000014',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0005',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 3000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 3000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 3000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const seen: Array<{ stripeAccountId?: string }> = [];
    const provider = {
      generateLink: async (req: { stripeAccountId?: string }) => {
        seen.push({ stripeAccountId: req.stripeAccountId });
        return { linkId: 'plink_x', linkUrl: 'https://pay.mock.com/plink_x', providerReference: 'mock_x' };
      },
      deactivateLink: async () => undefined,
    };
    await createInvoicePaymentLink(tenantId, invoice.id, repo, provider, resolver);
    return seen[0]?.stripeAccountId;
  }

  it('does NOT pass stripeAccountId when Connect charges are not enabled (KYC incomplete)', async () => {
    const account = await seenAccountFor({
      resolveTenantConnectAccount: async () => ({ accountId: 'acct_pending', chargesEnabled: false }),
    });
    expect(account).toBeUndefined();
  });

  it('does NOT pass stripeAccountId when the tenant has no Connect account (resolver returns null)', async () => {
    const account = await seenAccountFor({
      resolveTenantConnectAccount: async () => null,
    });
    expect(account).toBeUndefined();
  });

  it('falls back to platform (no stripeAccountId) when the resolver throws', async () => {
    const account = await seenAccountFor({
      resolveTenantConnectAccount: async () => {
        throw new Error('db hiccup');
      },
    });
    expect(account).toBeUndefined();
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

describe('P0-1 — void/cancel deactivates the hosted payment link', () => {
  const TENANT = 'tenant-1';

  async function setup() {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice, transitionInvoiceStatus } =
      await import('../../src/invoices/invoice');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const { buildLineItem } = await import('../../src/shared/billing-engine');

    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-LINK-1',
        lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
    await invoiceRepo.update(TENANT, invoice.id, {
      stripePaymentLinkId: 'plink_void_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/plink_void_1',
      updatedAt: new Date(),
    });
    return { invoiceRepo, auditRepo, invoiceId: invoice.id, transitionInvoiceStatus };
  }

  it('voiding an invoice deactivates its link, clears the columns, and audits both', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    const deactivated: Array<{ linkId: string; account?: string }> = [];
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async (linkId: string, account?: string) => {
        deactivated.push({ linkId, account });
      },
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: 'u-1', actorRole: 'owner' },
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    expect(deactivated).toEqual([{ linkId: 'plink_void_1', account: undefined }]);

    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
    expect(reloaded!.stripePaymentLinkUrl).toBeUndefined();

    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('invoice.status_changed');
    expect(events).toContain('invoice.payment_link_deactivated');
  });

  it('a Stripe deactivation failure keeps the link columns (exposure stays visible) and audits the failure', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => { throw new Error('stripe 500'); },
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: 'u-1', actorRole: 'owner' },
      paymentLink: { provider },
    });

    // The void itself is never blocked…
    expect(result!.status).toBe('void');
    // …but the live-link exposure is not hidden, and the failure is audited.
    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBe('plink_void_1');
    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('invoice.payment_link_deactivation_failed');
    expect(events).not.toContain('invoice.payment_link_deactivated');
  });

  it('a Connect-minted link is deactivated with the tenant account header', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    const deactivated: Array<{ linkId: string; account?: string }> = [];
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async (linkId: string, account?: string) => {
        deactivated.push({ linkId, account });
      },
    };

    await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: {
        provider,
        connectAccountResolver: {
          resolveTenantConnectAccount: async () => ({ accountId: 'acct_123', chargesEnabled: true }),
        },
      },
    });

    expect(deactivated).toEqual([{ linkId: 'plink_void_1', account: 'acct_123' }]);
  });

  it('an invoice with no link voids cleanly with no provider call', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    await invoiceRepo.update(TENANT, invoiceId, {
      stripePaymentLinkId: null,
      stripePaymentLinkUrl: null,
      updatedAt: new Date(),
    });
    let calls = 0;
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => { calls += 1; },
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    expect(calls).toBe(0);
  });
});
