/**
 * Tradesperson wave 1, Task 4 — apply_credit execution handler tests.
 *
 * `apply_credit` reduces what a customer owes on an ISSUED invoice
 * (goodwill, warranty labor, price match). It mirrors `apply_late_fee`'s
 * mutation shape (non-taxable line-item append + shared billing-engine
 * totals recompute + money-state rollup refresh) with a NEGATIVE line and a
 * floor guard: a credit may never exceed the invoice's outstanding amount
 * due. Over-crediting is a refund — that's `record_refund`'s job, not this
 * one's.
 *
 * Covers: valid-type + money-class classification, payload validation
 * (positive amountCents only), the floor guard (failure + success paths),
 * non-taxable line-item shape (with/without a stated reason), the
 * issued-status precondition (mirrors apply_late_fee's open/partially_paid
 * check), dev-wiring passthrough, and tenant isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ApplyCreditExecutionHandler } from '../../src/proposals/execution/apply-credit-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal, VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

const TENANT = 't-1';
const OTHER_TENANT = 't-2';
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

// Labor priced at 3000¢ so amountDueCents starts at exactly 3000 with no
// payments applied — matches the plan's floor-guard scenario verbatim.
function makeInvoice(overrides: Partial<Invoice> = {}, taxRateBps = 0): Invoice {
  const lineItems: LineItem[] = [buildLineItem('li-1', 'Labor', 1, 3000, 0, true, 'labor')];
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
    proposalType: 'apply_credit',
    status: 'approved',
    payload: { invoiceId: INVOICE_ID, amountCents: 2000, reason: 'goodwill — repeat leak' },
    summary: 'Apply credit to INV-0001',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('apply_credit proposal type', () => {
  it('is a valid proposal type classified as money', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('apply_credit');
    expect(actionClassForProposalType('apply_credit')).toBe('money');
  });

  it('accepts a well-formed payload and rejects non-positive credit', () => {
    expect(
      validateProposalPayload('apply_credit', {
        invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        amountCents: 5000,
        reason: 'goodwill — repeat leak',
      }).valid,
    ).toBe(true);
    expect(
      validateProposalPayload('apply_credit', {
        invoiceId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        amountCents: -5000,
      }).valid,
    ).toBe(false);
  });
});

describe('apply_credit execution handler', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let auditRepo: InMemoryAuditRepository;
  let handler: ApplyCreditExecutionHandler;
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeInvoice());
    handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);
  });

  it('refuses a credit that exceeds the amount due — floor guard, no mutation, points at record_refund', async () => {
    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 5000 } }),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds amount due/i);
    expect(result.error).toMatch(/record a refund/i);

    const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(untouched!.lineItems).toHaveLength(1);
    expect(untouched!.amountDueCents).toBe(3000);
  });

  it('applies a credit within the amount due and reduces the balance (re-read from the repo)', async () => {
    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 2000 } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(INVOICE_ID);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(updated!.amountDueCents).toBe(1000);
    expect(updated!.totals.totalCents).toBe(1000);
  });

  it('a credit exactly equal to the amount due is allowed (zeroes the balance, not over-crediting)', async () => {
    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 3000 } }),
      ctx,
    );

    expect(result.success).toBe(true);
    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(updated!.amountDueCents).toBe(0);
    // Deliberate product posture: a full credit zeroes the balance but does
    // NOT flip the invoice to 'paid' — no money actually changed hands, so
    // "paid" would misrepresent it (product follow-up filed for a possible
    // future 'credited'/closed status). Pinned so a future status-flip
    // change breaks loudly instead of silently.
    expect(updated!.status).toBe('open');
  });

  it('appends a non-taxable credit line with the reason folded into the description', async () => {
    await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 2000, reason: 'goodwill — repeat leak' } }),
      ctx,
    );

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    const creditLine = updated!.lineItems.find((li) => li.id !== 'li-1');
    expect(creditLine).toBeDefined();
    expect(creditLine!.description).toBe('Credit — goodwill — repeat leak');
    expect(creditLine!.quantity).toBe(1);
    expect(creditLine!.unitPriceCents).toBe(-2000);
    expect(creditLine!.taxable).toBe(false);
  });

  it('uses a bare "Credit" description when no reason was stated', async () => {
    await handler.execute(makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 2000 } }), ctx);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    const creditLine = updated!.lineItems.find((li) => li.id !== 'li-1');
    expect(creditLine!.description).toBe('Credit');
  });

  it('does NOT tax the credit line (fee excluded from taxable subtotal)', async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice({}, 1000)); // 10% tax
    handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);

    // 3000 base + 10% tax = 300 -> totalCents 3300, amountDueCents 3300.
    const before = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(before!.amountDueCents).toBe(3300);

    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 1000 } }),
      ctx,
    );
    expect(result.success).toBe(true);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(updated!.totals.taxCents).toBe(300); // unchanged — credit not taxed
    expect(updated!.totals.totalCents).toBe(2300);
    expect(updated!.amountDueCents).toBe(2300);
  });

  it('refuses to credit a non-issued invoice (draft) — clean failure, no mutation', async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(makeInvoice({ status: 'draft' }));
    handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 1000 } }),
      ctx,
    );
    expect(result.success).toBe(false);

    const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(untouched!.lineItems).toHaveLength(1);
  });

  it('applies to a partially_paid invoice and nets against the amount already paid', async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(
      makeInvoice({ status: 'partially_paid', amountPaidCents: 1000, amountDueCents: 2000 }),
    );
    handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 1000 } }),
      ctx,
    );
    expect(result.success).toBe(true);

    const updated = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // total 3000 - 1000 credit = 2000; 2000 - 1000 paid = 1000 due.
    expect(updated!.amountDueCents).toBe(1000);
  });

  // Quality-review fix — the floor guard compares against amountDueCents,
  // NOT the invoice's total/invoiced amount. Every other floor-guard test in
  // this file uses amountPaidCents: 0, where amountDueCents === totalCents,
  // so a guard mistakenly written as `amountCents > invoice.totals.totalCents`
  // would have passed every prior test in this file too. This case pins the
  // discriminating band: total 3000, paid 1000 -> amountDueCents 2000, and a
  // 2500 credit is BELOW the total (3000) but ABOVE the amount due (2000) —
  // only a guard keyed on amountDueCents correctly refuses it.
  it('floor guard keys off amountDueCents, not the invoice total (partially_paid, credit between due and total)', async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(
      makeInvoice({ status: 'partially_paid', amountPaidCents: 1000, amountDueCents: 2000 }),
    );
    handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 2500 } }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds amount due/i);

    const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(untouched!.lineItems).toHaveLength(1);
    expect(untouched!.amountDueCents).toBe(2000);
    expect(untouched!.amountPaidCents).toBe(1000);
  });

  it('rejects an invalid payload (missing amount) without throwing', async () => {
    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID } }),
      ctx,
    );
    expect(result.success).toBe(false);
  });

  it('degrades to a synthetic-id passthrough when no invoiceRepo is wired', async () => {
    const bare = new ApplyCreditExecutionHandler();
    const result = await bare.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(INVOICE_ID);
  });

  it('isFullyWired reflects whether an invoiceRepo is present', () => {
    expect(new ApplyCreditExecutionHandler(invoiceRepo).isFullyWired()).toBe(true);
    expect(new ApplyCreditExecutionHandler().isFullyWired()).toBe(false);
  });

  it('tenant isolation — cannot credit another tenant’s invoice', async () => {
    const result = await handler.execute(makeProposal(), { tenantId: OTHER_TENANT, executedBy: 'u-2' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(untouched!.lineItems).toHaveLength(1);
    expect(untouched!.amountDueCents).toBe(3000);
  });

  it('emits a credit.applied audit event carrying proposalId/amountCents/reason', async () => {
    await handler.execute(
      makeProposal({ payload: { invoiceId: INVOICE_ID, amountCents: 2000, reason: 'goodwill — repeat leak' } }),
      ctx,
    );

    const events = await auditRepo.findByEntity(TENANT, 'invoice', INVOICE_ID);
    const event = events.find((e) => e.eventType === 'credit.applied');
    expect(event).toBeDefined();
    expect(event!.metadata).toMatchObject({
      proposalId: 'prop-1',
      proposalType: 'apply_credit',
      amountCents: 2000,
      reason: 'goodwill — repeat leak',
    });
  });
});
