/**
 * Collections cadence — send_payment_reminder execution handler tests.
 *
 * Covers: delivery through the transactional-comms path, invalid payload,
 * delivery-error handling (never throws through), dev-wiring passthrough,
 * and failure-soft audit emission.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SendPaymentReminderExecutionHandler } from '../../src/proposals/execution/send-payment-reminder-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal } from '../../src/proposals/proposal';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';

const TENANT = 't-1';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

class FakeComms {
  calls: Array<{ tenantId: string; invoiceId: string }> = [];
  shouldThrow = false;
  async notifyInvoiceOverdue(tenantId: string, invoiceId: string): Promise<void> {
    if (this.shouldThrow) throw new Error('delivery failed');
    this.calls.push({ tenantId, invoiceId });
  }
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'send_payment_reminder',
    status: 'approved',
    payload: { invoiceId: INVOICE_ID, stepKey: '3:sms', offsetDays: 3, channel: 'sms' },
    summary: 'Send payment reminder for INV-0001',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('send_payment_reminder execution handler', () => {
  let comms: FakeComms;
  let auditRepo: InMemoryAuditRepository;
  let handler: SendPaymentReminderExecutionHandler;
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  beforeEach(() => {
    comms = new FakeComms();
    auditRepo = new InMemoryAuditRepository();
    handler = new SendPaymentReminderExecutionHandler(
      comms as unknown as TransactionalCommsService,
      auditRepo,
    );
  });

  it('delivers the reminder through transactional comms and audits it', async () => {
    const result = await handler.execute(makeProposal(), ctx);

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(INVOICE_ID);
    expect(comms.calls).toEqual([{ tenantId: TENANT, invoiceId: INVOICE_ID }]);

    const events = await auditRepo.findByEntity(TENANT, 'invoice', INVOICE_ID);
    expect(events.some((e) => e.eventType === 'invoice.reminder_sent')).toBe(true);
  });

  it('returns a failed result (never throws) when delivery fails', async () => {
    comms.shouldThrow = true;
    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/delivery failed/i);
  });

  it('rejects an invalid payload (non-uuid invoice) without throwing', async () => {
    const result = await handler.execute(
      makeProposal({ payload: { invoiceId: 'nope', stepKey: '3:sms', offsetDays: 3, channel: 'sms' } }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(comms.calls).toHaveLength(0);
  });

  it('degrades to a synthetic-id passthrough when no comms service is wired', async () => {
    const bare = new SendPaymentReminderExecutionHandler();
    const result = await bare.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(INVOICE_ID);
  });
});
