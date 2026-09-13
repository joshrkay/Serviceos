/**
 * Wave B follow-up — apply_late_fee voice on-ramp (task-handler level).
 *
 * Money-class: the owner approves the amount; we surface what they stated
 * ("add a $25 late fee") or flag feeCents missing for the review card — we
 * never invent a charge. stepKey 'manual' marks an on-demand fee (distinct
 * from the dunning ledger's accrual steps) and makes the fee line idempotent.
 * invoiceId is resolved from the reference by the review UI. No change to the
 * execution schema/handler the dunning sweep depends on.
 */
import { describe, it, expect } from 'vitest';
import { ApplyLateFeeTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { applyLateFeePayloadSchema } from '../../../src/proposals/contracts/apply-late-fee';
import { ApplyLateFeeExecutionHandler } from '../../../src/proposals/execution/apply-late-fee-handler';
import { InMemoryInvoiceRepository, type Invoice } from '../../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals, type LineItem } from '../../../src/shared/billing-engine';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('ApplyLateFeeTaskHandler', () => {
  it('uses the stated fee amount, keys stepKey=manual, captures the invoice reference', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice', amount: 2500 } }),
    );
    expect(res.proposal.proposalType).toBe('apply_late_fee');
    expect(res.proposal.payload.invoiceReference).toBe('the Smith invoice');
    expect(res.proposal.payload.feeCents).toBe(2500);
    expect(res.proposal.payload.stepKey).toBe('manual');
    // invoiceId always flagged missing (approval gate holds until resolved);
    // feeCents was stated, so it is not missing.
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
    expect(missingFieldsFor(res.proposal)).not.toContain('feeCents');
    expect(res.proposal.status).toBe('draft'); // money never auto-approves
  });

  it('flags feeCents missing when no amount was stated (never invents a charge)', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice' } }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('feeCents');
  });

  it('once invoiceId + feeCents are resolved, the payload satisfies the execution schema', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice', amount: 2500 } }),
    );
    const resolved = {
      ...res.proposal.payload,
      invoiceId: '11111111-1111-1111-1111-111111111111',
    };
    expect(applyLateFeePayloadSchema.safeParse(resolved).success).toBe(true);
  });

  it('flags both invoiceId and feeCents missing on a bare command', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toEqual(
      expect.arrayContaining(['invoiceId', 'feeCents']),
    );
  });
});

// ── U1 — resolver-verified invoiceId lifts the gate (resolve-then-gate) ────
//
// `apply_late_fee` is one of INVOICE_DOC_INTENTS: the router's entity
// resolver resolves "the Smith invoice" pre-draft and a UNIQUE verified match
// rides existingEntities.invoiceId. P-44: the lifted-gate case is proven by
// the EXECUTED EFFECT — the real ApplyLateFeeExecutionHandler appends the
// late-fee line to the invoice and emits the audit event — never just
// proposal shape.
describe('ApplyLateFeeTaskHandler — U1 resolver-verified invoiceId', () => {
  const RESOLVED_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  function openInvoice(id: string): Invoice {
    const lineItems: LineItem[] = [buildLineItem('li-1', 'Service call', 1, 10000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    return {
      id,
      tenantId: 't-1',
      jobId: 'job-1',
      invoiceNumber: 'INV-0042',
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: 'u-1',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
  }

  it('resolver seam lifts the gate ("$25 late fee" → 2500 cents); the payload EXECUTES: fee line lands on the invoice + audit row', async () => {
    // The classifier extracts integer cents ("twenty-five dollars" → 2500);
    // the handler passes them through unchanged — no float math anywhere.
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice', invoiceId: RESOLVED_ID, amount: 2500 } }),
    );
    expect(res.proposal.payload.invoiceId).toBe(RESOLVED_ID);
    expect(res.proposal.payload.feeCents).toBe(2500);
    expect(res.proposal.payload.invoiceReference).toBe('the Smith invoice');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    // Money class — a fully-resolved draft STILL never auto-approves.
    expect(res.proposal.status).toBe('draft');

    // Executed effect: real execution handler + in-memory repo — the open
    // invoice gains a non-taxable 'Late fee' line of exactly 2500 cents and
    // the invoice.late_fee_applied audit event is emitted.
    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(openInvoice(RESOLVED_ID));
    const auditRepo = new InMemoryAuditRepository();
    const exec = await new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo).execute(
      res.proposal,
      { tenantId: 't-1', executedBy: 'u-1' },
    );
    expect(exec.success).toBe(true);

    const updated = await invoiceRepo.findById('t-1', RESOLVED_ID);
    const feeLine = updated!.lineItems.find((li) => li.description === 'Late fee');
    expect(feeLine).toBeDefined();
    expect(feeLine!.unitPriceCents).toBe(2500);
    expect(updated!.amountDueCents).toBe(10000 + 2500);

    const audits = await auditRepo.findByEntity('t-1', 'invoice', RESOLVED_ID);
    expect(audits.map((a) => a.eventType)).toContain('invoice.late_fee_applied');
  });

  it('a non-UUID value in the invoiceId seam never lifts the gate', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice', invoiceId: 'smith', amount: 2500 } }),
    );
    expect(res.proposal.payload.invoiceId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
  });

  it('resolved invoiceId with NO stated amount still gates on feeCents (never invents a charge)', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice', invoiceId: RESOLVED_ID } }),
    );
    expect(res.proposal.payload.invoiceId).toBe(RESOLVED_ID);
    expect(missingFieldsFor(res.proposal)).toEqual(['feeCents']);
  });
});
