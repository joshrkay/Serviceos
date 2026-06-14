/**
 * Collections cadence — apply_late_fee execution handler tests.
 *
 * Covers: non-taxable fee application with to-the-cent total recompute,
 * idempotent re-execution (no double charge), status guards (only overdue
 * invoices), invalid payload, dev-wiring passthrough, and tenant isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApplyLateFeeExecutionHandler } from '../../src/proposals/execution/apply-late-fee-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal } from '../../src/proposals/proposal';
import {
  buildLineItem,
  calculateDocumentTotals,
  LineItem,
} from '../../src/shared/billing-engine';

const TENANT = 't-1';
const OTHER_TENANT = 't-2';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function makeInvoice(overrides: Partial<Invoice> = {}, taxRateBps = 0): Invoice {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Labor', 1, 15000, 0, true, 'labor'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, taxRateBps);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-1',
    invoiceNumber: 'INV-0001',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'apply_late_fee',
    status: 'approved',
    payload: { invoiceId: INVOICE_ID, feeCents: 2500, stepKey: 'initial' },
    summary: 'Apply late fee to INV-0001',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('apply_late_fee execution handler', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;
  let handler: ApplyLateFeeExecutionHandler;
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeInvoice());
    handler = new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo);
  });

  it('appends a late-fee line and raises amount due by exactly the fee (no tax)', async () => {
    const result = await handler.execute(makeProposal(), ctx);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(INVOICE_ID);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    const fee = updated!.lineItems.find((li) => li.id === 'late-fee:initial');
    expect(fee).toBeDefined();
    expect(fee!.unitPriceCents).toBe(2500);
    expect(fee!.taxable).toBe(false);
    // 15000 base + 2500 fee, no tax → 17500 due.
    expect(updated!.amountDueCents).toBe(17500);
    expect(updated!.totals.totalCents).toBe(17500);
  });

  it('does NOT tax the late fee (fee excluded from taxable subtotal)', async () => {
    // 10% tax on a $150 line: base tax = 1500. Adding a $25 NON-taxable fee
    // must leave tax untouched and total = 15000 + 1500 + 2500 = 19000.
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice({}, 1000));
    handler = new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(updated!.totals.taxCents).toBe(1500); // unchanged — fee not taxed
    expect(updated!.totals.totalCents).toBe(19000);
    expect(updated!.amountDueCents).toBe(19000);
  });

  it('is idempotent — re-execution does not double-charge', async () => {
    await handler.execute(makeProposal(), ctx);
    const second = await handler.execute(makeProposal(), ctx);

    expect(second.success).toBe(true); // no-op success
    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    const feeLines = updated!.lineItems.filter((li) => li.id === 'late-fee:initial');
    expect(feeLines).toHaveLength(1);
    expect(updated!.amountDueCents).toBe(17500); // not 20000
  });

  it('refuses to fee a non-overdue invoice (paid) — clean failure, no mutation', async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice({ status: 'paid', amountPaidCents: 15000, amountDueCents: 0 }));
    handler = new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not overdue/i);

    const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(untouched!.lineItems.some((li) => li.id === 'late-fee:initial')).toBe(false);
  });

  it('applies to a partially_paid invoice and nets against the amount already paid', async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice({ status: 'partially_paid', amountPaidCents: 5000, amountDueCents: 10000 }));
    handler = new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // total 17500 − 5000 paid = 12500 due.
    expect(updated!.amountDueCents).toBe(12500);
  });

  it('rejects an invalid payload (missing fee) without throwing', async () => {
    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, stepKey: 'initial' } }),
      ctx,
    );
    expect(result.success).toBe(false);
  });

  it('degrades to a synthetic-id passthrough when no invoiceRepo is wired', async () => {
    const bare = new ApplyLateFeeExecutionHandler();
    const result = await bare.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(INVOICE_ID);
  });

  it('tenant isolation — cannot fee another tenant’s invoice', async () => {
    // Execute with OTHER_TENANT context against TENANT's invoice: the
    // tenant-scoped findById returns null, so nothing is mutated.
    const result = await handler.execute(makeProposal(), {
      tenantId: OTHER_TENANT,
      executedBy: 'u-2',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(untouched!.lineItems.some((li) => li.id === 'late-fee:initial')).toBe(false);
    expect(untouched!.amountDueCents).toBe(15000);
  });
});
