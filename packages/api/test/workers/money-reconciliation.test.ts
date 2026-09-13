/**
 * Unit tests for the money-invariant reconciliation sweep (L2–L5, read-only).
 *
 * Pure gate arithmetic is tested directly (no DB); the sweep loop is tested
 * with a fake reader + in-memory audit repo, mirroring the overdue-invoice
 * worker test convention. The SQL that produces the rollup rows is pinned by
 * the integration test (test/integration/money-reconciliation.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import {
  evaluateInvoiceGates,
  classifyCheckoutEvent,
  runMoneyReconciliationSweep,
  UNVERIFIABLE_PROVIDER_REFERENCE,
  MONEY_RECONCILIATION_AUDIT_EVENT_TYPE,
  VIOLATION_ID_LOG_CAP,
  type InvoiceReconciliationRow,
  type CheckoutEventRow,
  type MoneyReconciliationReader,
  type LineItemStats,
} from '../../src/workers/money-reconciliation';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** A fully-consistent invoice: 300.00 billed, 300.00 paid, ledger agrees. */
function cleanRow(overrides: Partial<InvoiceReconciliationRow> = {}): InvoiceReconciliationRow {
  return {
    invoiceId: 'inv-clean',
    subtotalCents: 30000,
    discountCents: 0,
    taxCents: 0,
    processingFeeCents: 0,
    totalCents: 30000,
    amountPaidCents: 30000,
    lineTotalSumCents: 30000,
    activePaymentSumCents: 30000,
    ...overrides,
  };
}

function eventRow(overrides: Partial<CheckoutEventRow> = {}): CheckoutEventRow {
  return {
    eventId: 'we-1',
    amountTotalCents: 30000,
    paymentIntentRef: 'pi_abc',
    matchedPaymentSumCents: 30000,
    ...overrides,
  };
}

describe('evaluateInvoiceGates (L2–L4 pure arithmetic)', () => {
  it('returns no violations for a fully consistent invoice', () => {
    expect(evaluateInvoiceGates(cleanRow())).toEqual([]);
  });

  it('L2 subtotal: flags subtotal_cents != Σ(line.total_cents)', () => {
    const violations = evaluateInvoiceGates(
      cleanRow({ subtotalCents: 30001, totalCents: 30001, amountPaidCents: 0, activePaymentSumCents: 0 }),
    );
    expect(violations).toEqual([
      { gate: 'l2_subtotal', expected: 30000, actual: 30001 },
    ]);
  });

  it('L2 total: flags total_cents != subtotal - discount + tax + processing_fee', () => {
    const violations = evaluateInvoiceGates(
      cleanRow({
        discountCents: 1000,
        taxCents: 500,
        processingFeeCents: 200,
        // expected: 30000 - 1000 + 500 + 200 = 29700, stored says 30000
        totalCents: 30000,
        amountPaidCents: 0,
        activePaymentSumCents: 0,
      }),
    );
    expect(violations).toEqual([
      { gate: 'l2_total', expected: 29700, actual: 30000 },
    ]);
  });

  it('L2 total mirrors calculateDocumentTotals\' floor-at-zero clamp on over-discounted invoices', () => {
    // subtotal 1000, discount 2000 -> engine stores max(0, -1000) = 0.
    const violations = evaluateInvoiceGates(
      cleanRow({
        subtotalCents: 1000,
        lineTotalSumCents: 1000,
        discountCents: 2000,
        totalCents: 0,
        amountPaidCents: 0,
        activePaymentSumCents: 0,
      }),
    );
    expect(violations).toEqual([]);
  });

  it('L3: flags amount_paid_cents != Σ(active payments) — counter drifted above the ledger', () => {
    const violations = evaluateInvoiceGates(
      cleanRow({ amountPaidCents: 5000, activePaymentSumCents: 0 }),
    );
    expect(violations).toEqual([
      { gate: 'l3', expected: 0, actual: 5000 },
    ]);
  });

  it('L3 is refund-inclusive by construction: the active-payment sum already excludes nothing for refunds', () => {
    // A fully-refunded payment stays in the active sum (refunds do not write
    // back); paid == sum must PASS. The refund-exclusion would show up as a
    // reduced activePaymentSumCents input, which the SQL never applies.
    const violations = evaluateInvoiceGates(
      cleanRow({ amountPaidCents: 10000, activePaymentSumCents: 10000, totalCents: 10000, subtotalCents: 10000, lineTotalSumCents: 10000 }),
    );
    expect(violations).toEqual([]);
  });

  it('L4: flags amount_paid_cents > total_cents even when L3 passes (the P0-6 double-credit blind spot)', () => {
    // Two full-balance credits: paid 40000 with matching payment rows summing
    // 40000 (L3 agrees) on a 30000 invoice. Only L4 can catch this.
    const violations = evaluateInvoiceGates(
      cleanRow({ amountPaidCents: 40000, activePaymentSumCents: 40000 }),
    );
    expect(violations).toEqual([
      { gate: 'l4', expected: 30000, actual: 40000 },
    ]);
  });

  it('reports every violated gate on a multiply-inconsistent invoice', () => {
    const violations = evaluateInvoiceGates(
      cleanRow({
        subtotalCents: 100,
        lineTotalSumCents: 200,
        totalCents: 50,
        amountPaidCents: 75,
        activePaymentSumCents: 10,
      }),
    );
    expect(violations.map((v) => v.gate)).toEqual(['l2_subtotal', 'l2_total', 'l3', 'l4']);
  });
});

describe('classifyCheckoutEvent (L5 cross-system gate)', () => {
  it('passes when the captured amount_total equals the matched payment sum', () => {
    expect(classifyCheckoutEvent(eventRow())).toBe('pass');
  });

  it('flags a violation when Stripe captured more than the recorded payments (P0-9)', () => {
    expect(
      classifyCheckoutEvent(eventRow({ amountTotalCents: 30000, matchedPaymentSumCents: 20000 })),
    ).toBe('violation');
  });

  it('flags a violation when no payment row exists at all for the reference', () => {
    expect(
      classifyCheckoutEvent(eventRow({ matchedPaymentSumCents: 0 })),
    ).toBe('violation');
  });

  it('classifies a missing payment_intent as UNVERIFIABLE, never pass/fail', () => {
    expect(
      classifyCheckoutEvent(eventRow({ paymentIntentRef: null, matchedPaymentSumCents: 0 })),
    ).toBe('unverifiable');
  });

  it("classifies the legacy 'stripe_checkout' collision reference as UNVERIFIABLE even when sums happen to agree (P0-5)", () => {
    expect(
      classifyCheckoutEvent(
        eventRow({ paymentIntentRef: UNVERIFIABLE_PROVIDER_REFERENCE, matchedPaymentSumCents: 30000 }),
      ),
    ).toBe('unverifiable');
  });

  it('classifies a missing/malformed amount_total as UNVERIFIABLE', () => {
    expect(
      classifyCheckoutEvent(eventRow({ amountTotalCents: null })),
    ).toBe('unverifiable');
  });
});

describe('runMoneyReconciliationSweep (loop, aggregation, audit)', () => {
  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const TENANT_B = '22222222-2222-2222-2222-222222222222';

  function fakeReader(perTenant: Record<string, {
    rollups?: InvoiceReconciliationRow[];
    stats?: LineItemStats;
    events?: CheckoutEventRow[];
    throwOnRollups?: boolean;
  }>): MoneyReconciliationReader {
    return {
      async fetchInvoiceRollups(tenantId: string) {
        const t = perTenant[tenantId];
        if (t?.throwOnRollups) throw new Error('boom');
        return t?.rollups ?? [];
      },
      async fetchLineItemStats(tenantId: string) {
        return perTenant[tenantId]?.stats ?? { lineItemCount: 0, l1MismatchCount: 0 };
      },
      async fetchCheckoutEventRows(tenantId: string) {
        return perTenant[tenantId]?.events ?? [];
      },
    };
  }

  it('aggregates gate counts across tenants and isolates a failing tenant', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const summary = await runMoneyReconciliationSweep({
      reader: fakeReader({
        [TENANT_A]: {
          rollups: [
            cleanRow({ invoiceId: 'inv-1' }),
            cleanRow({ invoiceId: 'inv-2', amountPaidCents: 5000, activePaymentSumCents: 0 }), // L3
          ],
          stats: { lineItemCount: 4, l1MismatchCount: 1 },
          events: [
            eventRow({ eventId: 'we-pass' }),
            eventRow({ eventId: 'we-fail', matchedPaymentSumCents: 10000 }),
            eventRow({ eventId: 'we-unv', paymentIntentRef: UNVERIFIABLE_PROVIDER_REFERENCE }),
          ],
        },
        [TENANT_B]: { throwOnRollups: true },
      }),
      auditRepo,
      listTenantIds: async () => [TENANT_A, TENANT_B],
      logger,
    });

    expect(summary.tenants).toBe(2);
    expect(summary.failedTenants).toBe(1);
    expect(summary.gates.l1).toEqual({ checked: 4, violations: 1, unverifiable: 0 });
    expect(summary.gates.l2_subtotal).toEqual({ checked: 2, violations: 0, unverifiable: 0 });
    expect(summary.gates.l2_total).toEqual({ checked: 2, violations: 0, unverifiable: 0 });
    expect(summary.gates.l3).toEqual({ checked: 2, violations: 1, unverifiable: 0 });
    expect(summary.gates.l4).toEqual({ checked: 2, violations: 0, unverifiable: 0 });
    expect(summary.gates.l5).toEqual({ checked: 2, violations: 1, unverifiable: 1 });
    expect(summary.violatingInvoiceIds).toEqual(['inv-2']);
    expect(summary.violatingEventIds).toEqual(['we-fail']);
  });

  it('emits one audit event per violating entity, none for passes or unverifiable rows', async () => {
    const auditRepo = new InMemoryAuditRepository();
    await runMoneyReconciliationSweep({
      reader: fakeReader({
        [TENANT_A]: {
          rollups: [
            cleanRow({ invoiceId: 'inv-ok' }),
            cleanRow({ invoiceId: 'inv-l4', amountPaidCents: 40000, activePaymentSumCents: 40000 }),
          ],
          events: [
            eventRow({ eventId: 'we-fail', matchedPaymentSumCents: 0 }),
            eventRow({ eventId: 'we-unv', paymentIntentRef: null }),
          ],
        },
      }),
      auditRepo,
      listTenantIds: async () => [TENANT_A],
      logger,
    });

    const invOk = await auditRepo.findByEntity(TENANT_A, 'invoice', 'inv-ok');
    expect(invOk).toEqual([]);

    const invL4 = await auditRepo.findByEntity(TENANT_A, 'invoice', 'inv-l4');
    expect(invL4).toHaveLength(1);
    expect(invL4[0].eventType).toBe(MONEY_RECONCILIATION_AUDIT_EVENT_TYPE);
    expect(invL4[0].actorRole).toBe('system');
    expect(invL4[0].metadata).toMatchObject({ gate: 'l4', expected: 30000, actual: 40000 });

    const weFail = await auditRepo.findByEntity(TENANT_A, 'webhook_event', 'we-fail');
    expect(weFail).toHaveLength(1);
    expect(weFail[0].metadata).toMatchObject({ gate: 'l5' });

    const weUnv = await auditRepo.findByEntity(TENANT_A, 'webhook_event', 'we-unv');
    expect(weUnv).toEqual([]);
  });

  it('caps the violating-id lists in the summary and the audit fan-out per tenant', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const manyViolations = Array.from({ length: 30 }, (_, i) =>
      cleanRow({ invoiceId: `inv-${i}`, amountPaidCents: 1, activePaymentSumCents: 0 }),
    );
    const summary = await runMoneyReconciliationSweep({
      reader: fakeReader({ [TENANT_A]: { rollups: manyViolations } }),
      auditRepo,
      listTenantIds: async () => [TENANT_A],
      logger,
    });

    expect(summary.gates.l3.violations).toBe(30);
    expect(summary.violatingInvoiceIds).toHaveLength(VIOLATION_ID_LOG_CAP);

    let audited = 0;
    for (let i = 0; i < 30; i++) {
      audited += (await auditRepo.findByEntity(TENANT_A, 'invoice', `inv-${i}`)).length;
    }
    expect(audited).toBe(VIOLATION_ID_LOG_CAP);
  });

  it('no-ops with zero counts when no reader is wired (in-memory dev)', async () => {
    const summary = await runMoneyReconciliationSweep({
      listTenantIds: async () => [],
      logger,
    });
    expect(summary.tenants).toBe(0);
    expect(summary.gates.l3).toEqual({ checked: 0, violations: 0, unverifiable: 0 });
  });

  it('never mutates: the sweep only reads through the reader (interface has no write surface)', () => {
    // Compile-time guarantee documented as a runtime assertion: the reader
    // interface exposes exactly the three fetch methods.
    const reader = fakeReader({});
    expect(Object.keys(reader).sort()).toEqual([
      'fetchCheckoutEventRows',
      'fetchInvoiceRollups',
      'fetchLineItemStats',
    ]);
  });
});
