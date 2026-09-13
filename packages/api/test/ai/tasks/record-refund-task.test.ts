/**
 * Tradesperson wave 1, Task 3 — RecordRefundTaskHandler (drafting leg).
 *
 * Unlike UpdateCatalogItemTaskHandler (Task 2), this handler does NOT
 * resolve its own reference: `record_refund` joins `INVOICE_DOC_INTENTS`
 * (entity-resolution.ts), so the voice-action-router resolves the spoken
 * invoice reference to a verified `invoiceId` BEFORE this handler runs
 * (or short-circuits to a `voice_clarification` on ambiguity, or leaves it
 * absent on no match) and stamps it onto `context.existingEntities` —
 * mirrored by `ComplaintTaskHandler`'s router-injected `jobId`/`customerId`
 * pattern. The "unique match / ambiguous / zero-match" resolution behavior
 * itself is pinned generically at that layer
 * (test/ai/agents/customer-calling/entity-resolution.test.ts); these tests
 * cover what THIS handler does with an already-resolved (or unresolved)
 * `invoiceId`.
 */
import { describe, it, expect } from 'vitest';
import { RecordRefundTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';

const TENANT_ID = 't-1';
const INVOICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'refund the customer',
    ...overrides,
  };
}

describe('RecordRefundTaskHandler', () => {
  it('a resolved invoiceId + amount drafts ungated with method defaulted to cash', async () => {
    const { proposal, taskType } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 10000 } }),
    );

    expect(taskType).toBe('record_refund');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('money');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.invoiceId).toBe(INVOICE_ID);
    expect(payload.amountCents).toBe(10000);
    expect(payload.method).toBe('cash');
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('an unresolved reference (no invoiceId stamped by the router) gates with a FLAT invoiceId key', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { amount: 10000 } }),
    );

    // Flat key — never prose. clearSatisfiedMissingFields only lifts a gate
    // on an exact flat-key edit.
    expect(missingFieldsFor(proposal)).toContain('invoiceId');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a raw free-text jobReference alone (never resolved) does NOT satisfy invoiceId — this contract has no invoiceReference fallback', async () => {
    // Unlike record_payment, whose contract accepts invoiceReference as a
    // free-text alternative, record_refund gates on the RESOLVED id only.
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'INV-0042', amount: 10000 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('invoiceId');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.invoiceId).toBeUndefined();
  });

  it('a missing amount gates with a FLAT amountCents key', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID } }),
    );

    expect(missingFieldsFor(proposal)).toContain('amountCents');
  });

  it('a zero or negative spoken amount is not trusted as a real amount (gates, mirrors other handlers\' sanity checks)', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: -500 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('amountCents');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.amountCents).toBeUndefined();
  });

  it('a stated refundMethod overrides the cash default', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({
        existingEntities: { invoiceId: INVOICE_ID, amount: 7500, refundMethod: 'check' },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.method).toBe('check');
  });

  it('checkNumber and reason pass through when spoken', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({
        existingEntities: {
          invoiceId: INVOICE_ID,
          amount: 7500,
          refundMethod: 'check',
          refundCheckNumber: '2044',
          refundReason: 'recharge did not hold',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.checkNumber).toBe('2044');
    expect(payload.reason).toBe('recharge did not hold');
  });

  it('omits reason/checkNumber entirely when not spoken (never fabricated blanks)', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 10000 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.reason).toBeUndefined();
    expect(payload.checkNumber).toBeUndefined();
  });

  it('rounds a fractional spoken amount to the nearest cent', async () => {
    const { proposal } = await new RecordRefundTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 4599.6 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.amountCents).toBe(4600);
    expect(missingFieldsFor(proposal)).not.toContain('amountCents');
  });
});
