/**
 * Tradesperson wave 1, Task 4 — ApplyCreditTaskHandler (drafting leg).
 *
 * Mirrors RecordRefundTaskHandler (Task 3): `apply_credit` joins
 * `INVOICE_DOC_INTENTS` (entity-resolution.ts), so the voice-action-router
 * resolves the spoken invoice reference to a verified `invoiceId` BEFORE
 * this handler runs (or short-circuits to a `voice_clarification` on
 * ambiguity, or leaves it absent on no match) and stamps it onto
 * `context.existingEntities`. These tests cover what THIS handler does with
 * an already-resolved (or unresolved) `invoiceId` — the generic resolution
 * behavior itself is pinned in
 * test/ai/agents/customer-calling/entity-resolution.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ApplyCreditTaskHandler } from '../../../src/ai/tasks/apply-credit-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';

const TENANT_ID = 't-1';
const INVOICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'knock 50 off the invoice',
    ...overrides,
  };
}

describe('ApplyCreditTaskHandler', () => {
  it('a resolved invoiceId + amount drafts ungated', async () => {
    const { proposal, taskType } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 5000 } }),
    );

    expect(taskType).toBe('apply_credit');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('money');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.invoiceId).toBe(INVOICE_ID);
    expect(payload.amountCents).toBe(5000);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('an unresolved reference (no invoiceId stamped by the router) gates with a FLAT invoiceId key', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { amount: 5000 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('invoiceId');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a raw free-text jobReference alone (never resolved) does NOT satisfy invoiceId', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'INV-0042', amount: 5000 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('invoiceId');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.invoiceId).toBeUndefined();
  });

  it('a missing amount gates with a FLAT amountCents key', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID } }),
    );

    expect(missingFieldsFor(proposal)).toContain('amountCents');
  });

  it('a zero or negative spoken amount is not trusted as a real amount (gates)', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: -500 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('amountCents');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.amountCents).toBeUndefined();
  });

  it('rounds a fractional spoken amount to the nearest cent', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 4599.6 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.amountCents).toBe(4600);
    expect(missingFieldsFor(proposal)).not.toContain('amountCents');
  });

  it('creditReason passes through trimmed when spoken', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({
        existingEntities: { invoiceId: INVOICE_ID, amount: 5000, creditReason: '  repeat leak  ' },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.reason).toBe('repeat leak');
  });

  it('omits reason entirely when not spoken (never fabricated)', async () => {
    const { proposal } = await new ApplyCreditTaskHandler().handle(
      ctx({ existingEntities: { invoiceId: INVOICE_ID, amount: 5000 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.reason).toBeUndefined();
  });
});
