/**
 * PR review finding (2026-07) — SendInvoiceTaskHandler used to leave
 * missingFields EMPTY whenever a free-text reference ("the Henderson
 * invoice", jobReference "INV-0042") was extracted, only gating when NO
 * reference existed at all. approveProposal (proposals/actions.ts) blocks
 * ONLY on missingFields, and SendInvoiceExecutionHandler
 * (proposals/execution/voice-extended-handlers.ts) requires payload.invoiceId
 * to already be a UUID — it never reads invoiceReference, unlike
 * issue_invoice's execution handler which resolves a bare/"INV-0042"-style
 * reference by repo lookup. So a reference-only send_invoice proposal was
 * approvable and would then fail at execution. This file pins the fix:
 * invoiceId is now always flagged missing unless the extracted reference is
 * already a usable id, mirroring SendPaymentReminderTaskHandler /
 * ApplyLateFeeTaskHandler / SendEstimateNudgeTaskHandler.
 */
import { describe, it, expect } from 'vitest';
import { SendInvoiceTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { sendInvoicePayloadSchema } from '../../../src/proposals/contracts/send-invoice';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('SendInvoiceTaskHandler', () => {
  it('carries a customer-name reference but flags invoiceId missing (approval gate holds)', async () => {
    const res = await new SendInvoiceTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Henderson' } }),
    );
    expect(res.proposal.proposalType).toBe('send_invoice');
    expect(res.proposal.payload.invoiceReference).toBe('Henderson');
    expect(res.proposal.payload.invoiceId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
    expect(res.proposal.status).toBe('draft'); // comms never auto-approves
  });

  it('carries a job/invoice-number reference but flags invoiceId missing', async () => {
    const res = await new SendInvoiceTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'INV-0042' } }),
    );
    expect(res.proposal.payload.invoiceReference).toBe('INV-0042');
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
  });

  it('flags invoiceId missing when no reference was extracted at all', async () => {
    const res = await new SendInvoiceTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
    expect(res.proposal.payload.invoiceReference).toBeUndefined();
  });

  it('uses the reference directly as invoiceId (no gate) when it is already a UUID', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    const res = await new SendInvoiceTaskHandler().handle(
      ctx({ existingEntities: { jobReference: uuid } }),
    );
    expect(res.proposal.payload.invoiceId).toBe(uuid);
    expect(res.proposal.payload.invoiceReference).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).not.toContain('invoiceId');
  });

  it('once invoiceId is resolved, the payload satisfies the execution schema', async () => {
    const res = await new SendInvoiceTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Henderson', sendChannel: 'sms' } }),
    );
    // The review UI resolves the reference → invoiceId; the resulting
    // payload must parse against the schema the execution handler enforces.
    const resolved = {
      ...res.proposal.payload,
      invoiceId: '11111111-1111-1111-1111-111111111111',
    };
    expect(sendInvoicePayloadSchema.safeParse(resolved).success).toBe(true);
    expect(res.proposal.payload.channel).toBe('sms');
  });

  it('defaults channel to email when not extracted', async () => {
    const res = await new SendInvoiceTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Henderson' } }),
    );
    expect(res.proposal.payload.channel).toBe('email');
  });
});
