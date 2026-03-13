import {
  assessPaymentReadiness,
  createPaymentReadiness,
  validatePaymentReadinessInput,
  InMemoryPaymentReadinessRepository,
} from '../../src/invoices/payment-readiness';
import { Invoice } from '../../src/invoices/invoice';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems = overrides.lineItems || [buildLineItem('1', 'Service', 1, 10000, 1, true, 'labor')];
  const totals = overrides.totals || calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'inv-1',
    tenantId: 'tenant-1',
    jobId: 'job-1',
    invoiceNumber: 'INV-001',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('P5-010A — Payment-ready invoice metadata', () => {
  let repo: InMemoryPaymentReadinessRepository;

  beforeEach(() => {
    repo = new InMemoryPaymentReadinessRepository();
  });

  it('happy path — open invoice with amount due is eligible', () => {
    const invoice = makeInvoice({ status: 'open', amountDueCents: 10000 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('happy path — partially_paid invoice is eligible', () => {
    const invoice = makeInvoice({ status: 'partially_paid', amountDueCents: 5000 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(true);
  });

  it('happy path — creates payment readiness record', async () => {
    const readiness = await createPaymentReadiness('tenant-1', 'inv-1', true, repo);
    expect(readiness.id).toBeTruthy();
    expect(readiness.eligibleForPaymentLink).toBe(true);
    expect(readiness.paymentLinkStatus).toBe('none');
  });

  it('validation — required fields', () => {
    const errors = validatePaymentReadinessInput('', '');
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('invoiceId is required');
  });

  it('tenant isolation — cross-tenant lookup returns null', async () => {
    await createPaymentReadiness('tenant-1', 'inv-1', true, repo);
    const found = await repo.findByInvoice('tenant-2', 'inv-1');
    expect(found).toBeNull();
  });

  it('zero amount edge case — invoice with 0 due is NOT eligible', () => {
    const invoice = makeInvoice({ status: 'open', amountDueCents: 0 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes('No amount due'))).toBe(true);
  });

  it('rounding boundary — invoice with 1 cent due is eligible', () => {
    const invoice = makeInvoice({ status: 'open', amountDueCents: 1 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(true);
  });

  it('status edge case — draft invoice not eligible', () => {
    const invoice = makeInvoice({ status: 'draft', amountDueCents: 10000 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(false);
  });

  it('status edge case — void invoice not eligible', () => {
    const invoice = makeInvoice({ status: 'void', amountDueCents: 10000 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(false);
  });

  it('status edge case — canceled invoice not eligible', () => {
    const invoice = makeInvoice({ status: 'canceled', amountDueCents: 10000 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(false);
  });

  it('status edge case — paid invoice not eligible', () => {
    const invoice = makeInvoice({ status: 'paid', amountDueCents: 0 });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(false);
  });

  it('partial payment arithmetic — partially paid invoice with remaining balance is eligible', () => {
    const invoice = makeInvoice({
      status: 'partially_paid',
      amountPaidCents: 6000,
      amountDueCents: 4000,
    });
    const result = assessPaymentReadiness(invoice);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('update — can update payment link status', async () => {
    await createPaymentReadiness('tenant-1', 'inv-1', true, repo);
    const updated = await repo.update('tenant-1', 'inv-1', {
      paymentLinkStatus: 'active',
      paymentLinkId: 'link-1',
      paymentLinkUrl: 'https://pay.stripe.com/link-1',
      paymentLinkCreatedAt: new Date(),
    });
    expect(updated).not.toBeNull();
    expect(updated!.paymentLinkStatus).toBe('active');
    expect(updated!.paymentLinkUrl).toBe('https://pay.stripe.com/link-1');
  });
});
