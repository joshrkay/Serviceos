/**
 * Stub execution handlers — production safety tests.
 *
 * These three handlers (add_note, send_invoice, record_payment) are
 * payload-validation-only stubs. Their `executed` transitions would
 * write a lie to the audit trail ("payment recorded") without any
 * actual downstream mutation. Production MUST refuse to run them
 * until real repos are wired. The `ENABLE_VOICE_STUBS=1` flag is
 * the staging escape hatch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Proposal, ProposalType } from '../../../src/proposals/proposal';
import {
  AddNoteExecutionHandler,
  SendInvoiceExecutionHandler,
  RecordPaymentExecutionHandler,
} from '../../../src/proposals/execution/voice-extended-handlers';

function fakeApproved(
  proposalType: ProposalType,
  payload: Record<string, unknown>
): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType,
    status: 'approved',
    payload,
    summary: 'test',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
    approvedAt: new Date(now.getTime() - 10_000),
  };
}

describe('voice-extended-handlers — production safety gate', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ENABLE_VOICE_STUBS;

  beforeEach(() => {
    delete process.env.ENABLE_VOICE_STUBS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    if (originalFlag === undefined) delete process.env.ENABLE_VOICE_STUBS;
    else process.env.ENABLE_VOICE_STUBS = originalFlag;
  });

  it('AddNoteExecutionHandler refuses to execute in NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const handler = new AddNoteExecutionHandler();
    const proposal = fakeApproved('add_note', {
      body: 'ring the doorbell twice',
      targetKind: 'job',
      targetReference: 'Rodriguez',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not yet implemented');
  });

  it('SendInvoiceExecutionHandler refuses to execute in NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const handler = new SendInvoiceExecutionHandler();
    const proposal = fakeApproved('send_invoice', {
      invoiceReference: 'INV-0042',
      channel: 'email',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not yet implemented');
  });

  it('RecordPaymentExecutionHandler refuses to execute in NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const handler = new RecordPaymentExecutionHandler();
    const proposal = fakeApproved('record_payment', {
      invoiceReference: 'INV-0042',
      amountCents: 45000,
      paymentMethod: 'cash',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not yet implemented');
  });

  it('ENABLE_VOICE_STUBS=1 allows staging to exercise the pipeline', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_VOICE_STUBS = '1';
    const handler = new RecordPaymentExecutionHandler();
    const proposal = fakeApproved('record_payment', {
      invoiceReference: 'INV-0042',
      amountCents: 45000,
      paymentMethod: 'cash',
    });

    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });

  it('dev/test environments run the stub without the flag (default-permissive)', async () => {
    process.env.NODE_ENV = 'development';
    const handler = new AddNoteExecutionHandler();
    const proposal = fakeApproved('add_note', {
      body: 'note',
      targetKind: 'job',
      targetReference: 'Rodriguez',
    });
    const result = await handler.execute(proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(result.success).toBe(true);
  });
});
