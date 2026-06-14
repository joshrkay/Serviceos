/**
 * Wave B follow-up — send_payment_reminder voice on-ramp (task-handler level).
 *
 * The SendPaymentReminderExecutionHandler already exists (delivers the overdue
 * notice). Its payload was built for the dunning sweep (stepKey/offsetDays/
 * channel), but those are audit-only metadata — the handler only acts on
 * invoiceId. The voice handler stamps manual defaults for the cadence fields
 * and flags invoiceId missing for the review UI, so an ad-hoc "chase the Smith
 * invoice" works without changing the execution schema the sweep depends on.
 */
import { describe, it, expect } from 'vitest';
import { SendPaymentReminderTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { sendPaymentReminderPayloadSchema } from '../../../src/proposals/contracts/send-payment-reminder';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('SendPaymentReminderTaskHandler', () => {
  it('carries the invoice reference, stamps manual cadence defaults, stays in draft', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice' } }),
    );
    expect(res.proposal.proposalType).toBe('send_payment_reminder');
    expect(res.proposal.payload.invoiceReference).toBe('the Smith invoice');
    expect(res.proposal.payload.stepKey).toBe('manual');
    expect(res.proposal.payload.offsetDays).toBe(0);
    expect(res.proposal.payload.channel).toBe('sms');
    // invoiceId always flagged missing → approval gate holds until resolved.
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
    expect(res.proposal.status).toBe('draft'); // comms never auto-approves
  });

  it('once invoiceId is resolved, the payload satisfies the execution schema', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Smith', sendChannel: 'email' } }),
    );
    // The review UI resolves the reference → invoiceId; the resulting payload
    // must parse against the schema the execution handler enforces.
    const resolved = {
      ...res.proposal.payload,
      invoiceId: '11111111-1111-1111-1111-111111111111',
    };
    expect(sendPaymentReminderPayloadSchema.safeParse(resolved).success).toBe(true);
    expect(res.proposal.payload.channel).toBe('email');
  });

  it('flags invoiceId missing when no reference was extracted', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
  });
});
