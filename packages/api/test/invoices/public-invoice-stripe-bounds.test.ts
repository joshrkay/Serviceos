/**
 * Reliability #5 — the public pay page mints (and, on a lost mint guard,
 * deactivates) a Stripe Payment Link. With no fetch injected (production),
 * both calls are bounded at 10 s: a mint that never answers fails like a
 * network failure, and a hung loser-link cleanup counts as a cleanup miss
 * (audited with the live link's id) instead of hanging the customer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { PublicInvoiceService } from '../../src/invoices/public-invoice-service';
import { Invoice, InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { fakeJson, hangingFetch, settleWithin, useProviderClock } from '../helpers/hanging-fetch';

const TENANT = 'tenant-public-invoice-bounds';
const VIEW_TOKEN = 'a-very-long-and-unguessable-token-bounds';

async function setup() {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const jobRepo = new InMemoryJobRepository();
  const auditRepo = new InMemoryAuditRepository();
  const jobId = uuidv4();
  await jobRepo.create({
    id: jobId, tenantId: TENANT, customerId: uuidv4(), locationId: uuidv4(), jobNumber: 'JOB-1',
    summary: 'Service', status: 'completed', priority: 'normal', createdBy: 'user-1',
    createdAt: new Date(), updatedAt: new Date(),
  });
  const invoice: Invoice = {
    id: uuidv4(), tenantId: TENANT, jobId, invoiceNumber: 'INV-0001', status: 'open',
    lineItems: [{ id: uuidv4(), description: 'Service', quantity: 1, unitPriceCents: 10000, totalCents: 10000, sortOrder: 0, taxable: true }],
    totals: { subtotalCents: 10000, taxableSubtotalCents: 10000, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 10000 },
    amountPaidCents: 0, amountDueCents: 10000, viewToken: VIEW_TOKEN, createdBy: 'user-1',
    createdAt: new Date(), updatedAt: new Date(),
  };
  await invoiceRepo.create(invoice);
  const service = new PublicInvoiceService({
    invoiceRepo,
    jobRepo,
    customerRepo: new InMemoryCustomerRepository(),
    settingsRepo: new InMemorySettingsRepository(),
    paymentRepo: new InMemoryPaymentRepository(),
    stripeConfig: { apiKey: 'sk_test_xxx' },
    auditRepo,
  });
  return { service, invoiceRepo, auditRepo };
}

describe('PublicInvoiceService.getOrCreateCheckoutUrl — Stripe calls bounded at 10 s', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a payment-link mint that never answers fails like a network failure', async () => {
    const { service } = await setup();
    vi.stubGlobal('fetch', hangingFetch((url) => url.endsWith('/v1/payment_links')));

    const outcome = await settleWithin(service.getOrCreateCheckoutUrl(VIEW_TOKEN), 10_000);

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.name).toBe('TimeoutError');
  });

  it('a hung cleanup of a mint-guard loser link is a cleanup miss: audited, customer told to retry', async () => {
    const { service, invoiceRepo, auditRepo } = await setup();
    vi.stubGlobal(
      'fetch',
      hangingFetch(
        (url) => url.endsWith('/v1/payment_links/plink_loser'),
        () => fakeJson({ id: 'plink_loser', url: 'https://checkout.stripe.com/c/plink_loser' }),
      ),
    );
    // A void/credit landed while Stripe was minting: the guarded persist loses.
    vi.spyOn(invoiceRepo, 'attachPaymentLink').mockResolvedValueOnce({ ok: false, reason: 'not_payable' });

    const outcome = await settleWithin(service.getOrCreateCheckoutUrl(VIEW_TOKEN), 10_000);

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: Error }).reason.message).toMatch(/Invoice changed while the payment link was being created/);
    const audited = (await auditRepo.findByEntity(TENANT, 'invoice', (await invoiceRepo.findByTenant(TENANT))[0].id))
      .filter((e) => e.eventType === 'invoice.payment_link_deactivation_failed');
    expect(audited.map((e) => e.metadata?.stripePaymentLinkId)).toEqual(['plink_loser']);
  });
});
