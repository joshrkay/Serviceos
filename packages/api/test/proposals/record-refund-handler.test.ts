/**
 * Tradesperson wave 1, Task 3 — record_refund proposal type.
 *
 * record_refund is a NEW money-class proposal type for recording MANUAL
 * refunds (cash/check/external card) given back to a customer.
 * Stripe-AUTOMATED refunds are explicitly OUT OF SCOPE (YAGNI) — see
 * RecordRefundExecutionHandler's doc comment for the full analysis.
 *
 * The execution handler deliberately reuses the EXISTING `recordRefund()`
 * domain function (payments/payment-service.ts) and `PaymentRepository`
 * rather than a new refund ledger: `payment_refunds`
 * (db/schema.ts 264_create_payment_refunds) is a Stripe-webhook
 * idempotency claim table (stripe_refund_id NOT NULL, no invoice_id
 * column) — not a general refund record. Writing into it directly for a
 * manual refund would either fabricate a fake Stripe id or bypass the
 * `refundedAmountCents <= amountCents` over-refund guard `recordRefund()`
 * already enforces atomically. These tests pin that the invariant is
 * enforced (never bypassed).
 *
 * Spec-review fix (2026-08-08): the handler used to LOOP recordRefund()
 * across every refundable payment (splitting a refund across a deposit +
 * final payment). That loop had a partial-state window — a concurrent
 * mutation between the headroom snapshot and a later chunk's write could
 * leave an earlier chunk committed with the overall execution reported
 * failed. The handler now applies a `record_refund` proposal to exactly
 * ONE payment (the oldest whose OWN headroom covers the full amount) —
 * a single `recordRefund()` call, already atomic, so there is no
 * multi-call sequence and no partial-state window even in theory. See
 * RecordRefundExecutionHandler's doc comment for the full analysis of why
 * a cross-payment transaction was rejected instead of fixed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { RecordRefundExecutionHandler } from '../../src/proposals/execution/record-refund-handler';
import type { Proposal } from '../../src/proposals/proposal';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT_ID = 't1';
const INVOICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: TENANT_ID,
    proposalType: 'record_refund',
    status: 'approved',
    payload,
    summary: 'Record refund',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  };
}

function makePayment(over: Partial<Payment> = {}): Payment {
  const now = new Date('2026-05-01T12:00:00Z');
  return {
    id: uuidv4(),
    tenantId: TENANT_ID,
    invoiceId: INVOICE_ID,
    amountCents: 10000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: now,
    processedBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    reversedAt: null,
    reversalReason: null,
    ...over,
  };
}

describe('record_refund proposal type', () => {
  it('is a valid proposal type classified as money (never auto-approves)', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('record_refund');
    expect(actionClassForProposalType('record_refund')).toBe('money');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('record_refund', {
      invoiceId: INVOICE_ID,
      amountCents: 10000,
      method: 'cash',
      reason: 'callback — recharge did not hold',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a zero/negative amount', () => {
    const result = validateProposalPayload('record_refund', {
      invoiceId: INVOICE_ID,
      amountCents: 0,
      method: 'cash',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing invoiceId', () => {
    const result = validateProposalPayload('record_refund', {
      amountCents: 10000,
      method: 'cash',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an invalid method', () => {
    const result = validateProposalPayload('record_refund', {
      invoiceId: INVOICE_ID,
      amountCents: 10000,
      method: 'venmo',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts card_external and other methods (never a bare "method" collision — house naming precedent)', () => {
    for (const method of ['cash', 'check', 'card_external', 'other']) {
      const result = validateProposalPayload('record_refund', {
        invoiceId: INVOICE_ID,
        amountCents: 500,
        method,
      });
      expect(result.valid).toBe(true);
    }
  });

  it('degrades to synthetic id without a repo, executes with one', async () => {
    const handler = new RecordRefundExecutionHandler();
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(
      makeProposal({
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        method: 'cash',
        reason: 'test',
      }),
      { tenantId: TENANT_ID, executedBy: 'u1' },
    );
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();
  });

  describe('wired against a real PaymentRepository', () => {
    let paymentRepo: InMemoryPaymentRepository;
    let auditRepo: InMemoryAuditRepository;
    let handler: RecordRefundExecutionHandler;

    beforeEach(() => {
      paymentRepo = new InMemoryPaymentRepository();
      auditRepo = new InMemoryAuditRepository();
      handler = new RecordRefundExecutionHandler(paymentRepo, auditRepo);
    });

    it('reports isFullyWired() true once a paymentRepo is supplied', () => {
      expect(handler.isFullyWired()).toBe(true);
    });

    it('records a refund against the single completed payment and emits refund.recorded', async () => {
      const payment = await paymentRepo.create(makePayment({ amountCents: 10000 }));

      const result = await handler.execute(
        makeProposal({ invoiceId: INVOICE_ID, amountCents: 4000, method: 'cash', reason: 'warranty' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );

      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBe(INVOICE_ID);

      const reread = await paymentRepo.findById(TENANT_ID, payment.id);
      expect(reread?.refundedAmountCents).toBe(4000);
      // The original payment row keeps its full magnitude — same invariant
      // recordRefund() enforces for Stripe-driven refunds.
      expect(reread?.amountCents).toBe(10000);

      const events = auditRepo.getAll();
      const refundRecorded = events.find((e) => e.eventType === 'refund.recorded');
      expect(refundRecorded).toBeDefined();
      expect(refundRecorded?.entityType).toBe('invoice');
      expect(refundRecorded?.entityId).toBe(INVOICE_ID);
      expect(refundRecorded?.metadata).toMatchObject({
        proposalId: 'prop-1',
        proposalType: 'record_refund',
        amountCents: 4000,
        method: 'cash',
      });
      // The underlying payment-ledger event also fires (already mapped in
      // analytics/audit-event-mapping.ts) — record_refund does not
      // duplicate that mapping, it only adds proposal-level traceability.
      expect(events.some((e) => e.eventType === 'payment.refunded')).toBe(true);
    });

    it('enforces the over-refund invariant: a refund exceeding the single payment fails and mutates nothing', async () => {
      const payment = await paymentRepo.create(makePayment({ amountCents: 5000 }));

      const result = await handler.execute(
        makeProposal({ invoiceId: INVOICE_ID, amountCents: 10000, method: 'cash' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds any single payment/i);

      const reread = await paymentRepo.findById(TENANT_ID, payment.id);
      expect(reread?.refundedAmountCents).toBe(0);
      expect(auditRepo.getAll()).toHaveLength(0);
    });

    // Required pinning test (spec review) — Option B, "chosen payment is the
    // oldest refundable one": both payments individually have enough
    // headroom to cover the request, so the deterministic oldest-first
    // tie-break is the only thing that decides which one is touched.
    it('picks the OLDEST refundable payment when more than one could individually cover the amount', async () => {
      const older = await paymentRepo.create(
        makePayment({ amountCents: 8000, receivedAt: new Date('2026-05-01T00:00:00Z') }),
      );
      const newer = await paymentRepo.create(
        makePayment({ amountCents: 9000, receivedAt: new Date('2026-05-02T00:00:00Z') }),
      );

      const result = await handler.execute(
        makeProposal({ invoiceId: INVOICE_ID, amountCents: 5000, method: 'check', checkNumber: '2044' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );

      expect(result.success).toBe(true);

      const rereadOlder = await paymentRepo.findById(TENANT_ID, older.id);
      const rereadNewer = await paymentRepo.findById(TENANT_ID, newer.id);
      // Only the older payment is touched — single-payment scope, never a
      // split, even though the newer one could ALSO have covered it alone.
      expect(rereadOlder?.refundedAmountCents).toBe(5000);
      expect(rereadNewer?.refundedAmountCents).toBe(0);
    });

    // Required pinning test (spec review) — the amount-fits-total-but-not-
    // any-single-payment case: two payments sum to more than enough
    // headroom, but NEITHER can individually cover the request. Must fail
    // BEFORE any write (never silently split, never partially apply).
    it('fails with a split-guidance message when the amount fits the combined total but no single payment can cover it, mutating nothing', async () => {
      const older = await paymentRepo.create(
        makePayment({ amountCents: 3000, receivedAt: new Date('2026-05-01T00:00:00Z') }),
      );
      const newer = await paymentRepo.create(
        makePayment({ amountCents: 4000, receivedAt: new Date('2026-05-02T00:00:00Z') }),
      );

      // Combined headroom is 7000 — comfortably covers 5000 — but no ONE
      // payment (3000 or 4000) does on its own.
      const result = await handler.execute(
        makeProposal({ invoiceId: INVOICE_ID, amountCents: 5000, method: 'cash' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds any single payment.*record it as separate smaller refunds/i);

      const rereadOlder = await paymentRepo.findById(TENANT_ID, older.id);
      const rereadNewer = await paymentRepo.findById(TENANT_ID, newer.id);
      expect(rereadOlder?.refundedAmountCents).toBe(0);
      expect(rereadNewer?.refundedAmountCents).toBe(0);
      expect(auditRepo.getAll()).toHaveLength(0);
    });

    it('ignores a payment that never settled (pending) and one already fully refunded when computing headroom', async () => {
      await paymentRepo.create(makePayment({ status: 'pending', amountCents: 20000 }));
      await paymentRepo.create(
        makePayment({ amountCents: 3000, refundedAmountCents: 3000 }),
      );
      const eligible = await paymentRepo.create(makePayment({ amountCents: 6000 }));

      const result = await handler.execute(
        makeProposal({ invoiceId: INVOICE_ID, amountCents: 6000, method: 'cash' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );

      expect(result.success).toBe(true);
      const reread = await paymentRepo.findById(TENANT_ID, eligible.id);
      expect(reread?.refundedAmountCents).toBe(6000);
    });

    it('fails when the invoice has no completed payments at all', async () => {
      const result = await handler.execute(
        makeProposal({ invoiceId: INVOICE_ID, amountCents: 1000, method: 'cash' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds any single payment/i);
    });

    it('rejects an invalid invoiceId without touching the repository', async () => {
      const result = await handler.execute(
        makeProposal({ invoiceId: 'not-a-uuid', amountCents: 1000, method: 'cash' }),
        { tenantId: TENANT_ID, executedBy: 'u1' },
      );
      expect(result.success).toBe(false);
    });
  });
});
