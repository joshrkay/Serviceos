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

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('ApplyLateFeeTaskHandler', () => {
  it('uses the stated fee amount, keys stepKey=manual, captures the invoice reference', async () => {
    const res = await new ApplyLateFeeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice', amount: 2500 } }),
    );
    expect(res.proposal.proposalType).toBe('apply_late_fee');
    // Reference present → resolved by the review UI; not a hard-missing field
    // (mirrors send_invoice / record_payment).
    expect(res.proposal.payload.invoiceReference).toBe('the Smith invoice');
    expect(res.proposal.payload.feeCents).toBe(2500);
    expect(res.proposal.payload.stepKey).toBe('manual');
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
