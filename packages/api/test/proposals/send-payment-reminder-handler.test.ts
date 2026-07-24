/**
 * Collections cadence — send_payment_reminder execution handler tests.
 *
 * Covers: delivery through the transactional-comms path, invalid payload,
 * delivery-error handling (never throws through), dev-wiring passthrough,
 * and failure-soft audit emission.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { SendPaymentReminderExecutionHandler } from '../../src/proposals/execution/send-payment-reminder-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal } from '../../src/proposals/proposal';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import {
  DunningEvent,
  DunningEventRepository,
  InMemoryDunningEventRepository,
  manualReminderStepKey,
} from '../../src/invoices/dunning-config';

const TENANT = 't-1';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

class FakeComms {
  calls: Array<{ tenantId: string; invoiceId: string; occurrenceToken: string }> = [];
  shouldThrow = false;
  /** Optional hook fired synchronously inside the send — lets a test observe
   *  the ledger state AT the moment of send (proves record-before-send). */
  onSend?: (tenantId: string, invoiceId: string) => Promise<void> | void;
  /** Set to suppress delivery (I10 — invoice paid/void/zero at fire time). */
  suppressReason?: 'paid' | 'void' | 'zero_balance' | 'not_found';
  async notifyInvoiceOverdue(
    tenantId: string,
    invoiceId: string,
    occurrenceToken: string,
  ): Promise<{ status: 'sent' } | { status: 'suppressed'; reason: string }> {
    if (this.shouldThrow) throw new Error('delivery failed');
    if (this.onSend) await this.onSend(tenantId, invoiceId);
    if (this.suppressReason) return { status: 'suppressed', reason: this.suppressReason };
    this.calls.push({ tenantId, invoiceId, occurrenceToken });
    return { status: 'sent' };
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
    expect(comms.calls).toEqual([
      { tenantId: TENANT, invoiceId: INVOICE_ID, occurrenceToken: '3:sms' },
    ]);

    const events = await auditRepo.findByEntity(TENANT, 'invoice', INVOICE_ID);
    expect(events.some((e) => e.eventType === 'invoice.reminder_sent')).toBe(true);
  });

  it('Codex P1 #1: distinct dunning steps (different stepKey) for the SAME invoice thread distinct occurrence tokens, not one entity-scoped key', async () => {
    await handler.execute(makeProposal({ payload: { invoiceId: INVOICE_ID, stepKey: '3:sms', offsetDays: 3, channel: 'sms' } }), ctx);
    await handler.execute(
      makeProposal({
        id: 'prop-2',
        payload: { invoiceId: INVOICE_ID, stepKey: '10:email', offsetDays: 10, channel: 'email' },
      }),
      ctx,
    );

    expect(comms.calls.map((c) => c.occurrenceToken)).toEqual(['3:sms', '10:email']);
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

// Layer 1 — MANUAL-send execution-time dedup guard (72h cooldown +
// record-first ledger idempotency). Cadence proposals are never gated here.
describe('send_payment_reminder — manual dedup guard', () => {
  const NOW = new Date('2026-05-14T12:00:00Z');
  const ONE_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
  const FOUR_DAYS_AGO = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000);

  let comms: FakeComms;
  let auditRepo: InMemoryAuditRepository;
  let ledger: InMemoryDunningEventRepository;
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  function makeManualProposal(id = 'manual-prop-1'): Proposal {
    return makeProposal({
      id,
      payload: { invoiceId: INVOICE_ID, stepKey: 'manual', offsetDays: 0, channel: 'sms' },
    });
  }

  function seed(event: Partial<DunningEvent>): Promise<DunningEvent> {
    return ledger.create({
      id: uuidv4(),
      tenantId: TENANT,
      invoiceId: INVOICE_ID,
      kind: 'reminder',
      stepKey: '3:sms',
      channel: 'sms',
      sentAt: ONE_HOUR_AGO,
      ...event,
    });
  }

  function handlerWith(repo?: DunningEventRepository): SendPaymentReminderExecutionHandler {
    return new SendPaymentReminderExecutionHandler(
      comms as unknown as TransactionalCommsService,
      auditRepo,
      repo,
      () => NOW,
    );
  }

  beforeEach(() => {
    comms = new FakeComms();
    auditRepo = new InMemoryAuditRepository();
    ledger = new InMemoryDunningEventRepository();
  });

  it('refuses a manual send when a recent CADENCE reminder is in the ledger (no comms)', async () => {
    await seed({ stepKey: '3:sms', sentAt: ONE_HOUR_AGO });
    const result = await handlerWith(ledger).execute(makeManualProposal(), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/72h/);
    expect(comms.calls).toHaveLength(0);
  });

  it('refuses a manual send when a recent FOREIGN manual reminder is in the ledger (no comms)', async () => {
    await seed({ stepKey: manualReminderStepKey('some-other-prop'), sentAt: ONE_HOUR_AGO });
    const result = await handlerWith(ledger).execute(makeManualProposal(), ctx);
    expect(result.success).toBe(false);
    expect(comms.calls).toHaveLength(0);
  });

  it('sends on a clean ledger and records the manual:<proposalId> row BEFORE the send', async () => {
    let rowExistedAtSend = false;
    const proposal = makeManualProposal('manual-prop-clean');
    comms.onSend = async () => {
      const rows = await ledger.findByInvoice(TENANT, INVOICE_ID);
      rowExistedAtSend = rows.some(
        (r) => r.stepKey === manualReminderStepKey(proposal.id) && r.kind === 'reminder',
      );
    };

    const result = await handlerWith(ledger).execute(proposal, ctx);

    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(1);
    expect(rowExistedAtSend).toBe(true); // record-first
    const rows = await ledger.findByInvoice(TENANT, INVOICE_ID);
    expect(rows.filter((r) => r.kind === 'reminder')).toHaveLength(1);
    expect(rows[0].channel).toBe('sms');
  });

  it('I10 suppression: a paid-at-fire-time reminder leaves NO ledger row and NO reminder_sent (Codex)', async () => {
    // Payment settled between raise and execute → comms suppresses the send.
    // The record-first ledger row must be undone (else its false send-history
    // blocks a later legitimate reminder), and the audit must reflect
    // suppression, not a send.
    comms.suppressReason = 'paid';
    const proposal = makeManualProposal('manual-prop-suppressed');

    const result = await handlerWith(ledger).execute(proposal, ctx);

    expect(result.success).toBe(true); // execution succeeded — it correctly sent nothing
    expect(comms.calls).toHaveLength(0);
    // The record-first row was deleted — no false "sent" history remains.
    const rows = await ledger.findByInvoice(TENANT, INVOICE_ID);
    expect(rows.filter((r) => r.kind === 'reminder')).toHaveLength(0);
    // Audited as suppressed, never as sent.
    const events = await auditRepo.findByEntity(TENANT, 'invoice', INVOICE_ID);
    expect(events.some((e) => e.eventType === 'invoice.reminder_suppressed')).toBe(true);
    expect(events.some((e) => e.eventType === 'invoice.reminder_sent')).toBe(false);
  });

  it('I10 suppression also removes the CADENCE ledger claim (Codex) so a reopened invoice can re-raise', async () => {
    // The overdue sweep (raiseDunningProposals) wrote the cadence row at raise
    // time; the handler does not record-first for cadence. If the step is
    // suppressed because the invoice is now paid, that pre-existing row must be
    // deleted too, else selectDueReminderSteps treats the step as sent forever.
    await seed({ stepKey: '3:sms', channel: 'sms', sentAt: NOW });
    comms.suppressReason = 'paid';
    const cadenceProposal = makeProposal({
      id: 'cadence-suppressed',
      payload: { invoiceId: INVOICE_ID, stepKey: '3:sms', offsetDays: 3, channel: 'sms' },
    });

    const result = await handlerWith(ledger).execute(cadenceProposal, ctx);

    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(0);
    const rows = await ledger.findByInvoice(TENANT, INVOICE_ID);
    expect(rows.filter((r) => r.kind === 'reminder' && r.stepKey === '3:sms')).toHaveLength(0);
  });

  it('re-executing the same manual proposal is idempotent — exactly one send total', async () => {
    const proposal = makeManualProposal('manual-prop-idem');
    const handler = handlerWith(ledger);

    const first = await handler.execute(proposal, ctx);
    const second = await handler.execute(proposal, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(comms.calls).toHaveLength(1); // never re-sent
    const rows = await ledger.findByInvoice(TENANT, INVOICE_ID);
    expect(rows.filter((r) => r.kind === 'reminder')).toHaveLength(1);
  });

  it('does NOT gate a cadence-step proposal even with a fresh manual row, and writes no extra ledger row', async () => {
    await seed({ stepKey: manualReminderStepKey('manual-prev'), sentAt: ONE_HOUR_AGO });
    const before = (await ledger.findByInvoice(TENANT, INVOICE_ID)).length;

    // A cadence proposal (stepKey '3:sms') — its ledger row was already written
    // by the sweep, so the handler neither gates nor re-records it.
    const cadence = makeProposal({
      id: 'cadence-prop',
      payload: { invoiceId: INVOICE_ID, stepKey: '3:sms', offsetDays: 3, channel: 'sms' },
    });
    const result = await handlerWith(ledger).execute(cadence, ctx);

    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(1); // sent, not gated
    const after = (await ledger.findByInvoice(TENANT, INVOICE_ID)).length;
    expect(after).toBe(before); // no second ledger write for cadence
  });

  it('allows a manual send when the only prior reminder is OUTSIDE the 72h window', async () => {
    await seed({ stepKey: '3:sms', sentAt: FOUR_DAYS_AGO });
    const result = await handlerWith(ledger).execute(makeManualProposal(), ctx);
    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(1);
  });

  it('Codex P1 (round 3): a manual send threads the per-proposal occurrence token (manual:<proposalId>), never the bare "manual" discriminator', async () => {
    // The bare 'manual' would make notifyInvoiceOverdue's send-claim key
    // invoice-scoped (invoice-overdue:{invoiceId}:manual) and permanently
    // tombstone every later manual reminder after the first. The token must be
    // per-proposal so each approved manual send is a distinct claim.
    const proposal = makeManualProposal('manual-prop-token');
    const result = await handlerWith(ledger).execute(proposal, ctx);
    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(1);
    expect(comms.calls[0].occurrenceToken).toBe(manualReminderStepKey('manual-prop-token'));
    expect(comms.calls[0].occurrenceToken).not.toBe('manual');
  });

  it('Codex P1 (round 3): two distinct manual proposals (spaced past the cooldown) thread DISTINCT occurrence tokens — the second is not suppressed by the first', async () => {
    // First manual send happened 4 days ago (outside the 72h cooldown) under a
    // different proposal id; its ledger row exists.
    await seed({ stepKey: manualReminderStepKey('manual-old'), sentAt: FOUR_DAYS_AGO });
    const second = makeManualProposal('manual-new');
    const result = await handlerWith(ledger).execute(second, ctx);

    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(1);
    // The second occurrence carries its own token — downstream the send-claim
    // ledger keys on this, so the first send's tombstone can't swallow it.
    expect(comms.calls[0].occurrenceToken).toBe(manualReminderStepKey('manual-new'));
    expect(comms.calls[0].occurrenceToken).not.toBe(manualReminderStepKey('manual-old'));
  });

  it('no dunningEventRepo → legacy behavior (manual send is not gated, no ledger)', async () => {
    const result = await handlerWith(undefined).execute(makeManualProposal(), ctx);
    expect(result.success).toBe(true);
    expect(comms.calls).toHaveLength(1);
  });
});
