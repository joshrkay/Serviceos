/**
 * E2a (one-time ACH "processing") — unit tests for the payment-domain
 * foundation: `recordProcessingPayment`, `settleProcessingPayment`,
 * `failProcessingPayment`, and the card-path regression after extracting
 * the shared `applySettledPayment` / `applyPaymentToInvoice` helpers.
 *
 * Mocked repos throughout (the real-column proof is the Docker-gated
 * integration test `test/integration/payments-ach-processing.test.ts`).
 *
 * The load-bearing assertions:
 *  - record processing: invoice UNCHANGED, audit `payment.processing`, no receipt.
 *  - settle: processing→completed, invoice paid, money-state INVOKED,
 *    receipt fired ONCE, audit type == `payment.recorded` (SAME as card).
 *  - concurrency (CAS): settle + fail fired together → exactly one wins,
 *    no phantom-paid.
 *  - R7 over-collection: processing 500, external 200, settle caps to 300.
 *  - amount_received drift: settle reconciles the row's amountCents.
 *  - idempotency: double-settle no-op; duplicate processing insert no-op.
 *  - card regression: recordPayment's balances/status/audit/money-state/
 *    receipt identical to before the helper extraction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryInvoiceRepository,
  Invoice,
  InvoiceRepository,
} from '../../src/invoices/invoice';
import {
  InMemoryPaymentRepository,
  recordPayment,
  recordProcessingPayment,
  applyPaymentToInvoice,
  PaymentReceiptNotifier,
} from '../../src/invoices/payment';
import {
  settleProcessingPayment,
  failProcessingPayment,
} from '../../src/payments/payment-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { RefreshJobMoneyStateDeps } from '../../src/jobs/job-money-state';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';

const TENANT = 'tenant-ach-1';
const INVOICE_ID = 'inv-ach-1';
const JOB_ID = 'job-ach-1';
const PI = 'pi_ach_test';

function makeOpenInvoice(totalCents = 50000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: JOB_ID,
    invoiceNumber: 'INV-ACH-1',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Money-state deps whose `jobRepo.findById` is a spy. `refreshJobMoneyState`
 * always calls it FIRST; returning null short-circuits the rollup to a
 * clean no-op (changed:false) while still proving the rollup was invoked.
 */
function makeMoneyStateDeps(invoiceRepo: InvoiceRepository): {
  deps: RefreshJobMoneyStateDeps;
  findById: ReturnType<typeof vi.fn>;
} {
  const findById = vi.fn().mockResolvedValue(null);
  const deps = {
    jobRepo: { findById } as unknown as RefreshJobMoneyStateDeps['jobRepo'],
    estimateRepo: new InMemoryEstimateRepository(),
    invoiceRepo,
  } as RefreshJobMoneyStateDeps;
  return { deps, findById };
}

function makeReceiptSpy(): PaymentReceiptNotifier & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async notifyPaymentReceived(_t: string, _i: string, amountCents: number) {
      calls.push(amountCents);
    },
  };
}

describe('applyPaymentToInvoice (pure math)', () => {
  it('floors amountDue at 0 and flips to paid when fully covered', () => {
    const inv = makeOpenInvoice(10000);
    expect(applyPaymentToInvoice(inv, 10000)).toEqual({
      amountPaidCents: 10000,
      amountDueCents: 0,
      status: 'paid',
    });
  });

  it('moves open → partially_paid on a partial', () => {
    const inv = makeOpenInvoice(10000);
    expect(applyPaymentToInvoice(inv, 3000)).toEqual({
      amountPaidCents: 3000,
      amountDueCents: 7000,
      status: 'partially_paid',
    });
  });

  it('leaves a terminal (void) status untouched', () => {
    const inv = { ...makeOpenInvoice(10000), status: 'void' as const };
    expect(applyPaymentToInvoice(inv, 5000).status).toBe('void');
  });
});

describe('recordProcessingPayment', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(50000));
  });

  it('inserts a processing row WITHOUT touching the invoice or firing a receipt', async () => {
    const receipt = makeReceiptSpy();
    const { payment, created } = await recordProcessingPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 50000,
        method: 'bank_transfer',
        providerReference: PI,
        processedBy: 'system:stripe_webhook',
      },
      paymentRepo,
      auditRepo,
    );

    expect(created).toBe(true);
    expect(payment.status).toBe('processing');
    expect(payment.providerReference).toBe(PI);

    // Invoice untouched — still open, nothing paid.
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(50000);

    // No receipt fired (passed nowhere — and the function takes no notifier).
    expect(receipt.calls).toHaveLength(0);

    // Audit: payment.processing (NOT payment.recorded).
    const events = auditRepo.getAll();
    expect(events.find((e) => e.eventType === 'payment.processing')).toBeDefined();
    expect(events.find((e) => e.eventType === 'payment.recorded')).toBeUndefined();
    const ev = events.find((e) => e.eventType === 'payment.processing')!;
    expect(ev.entityType).toBe('invoice');
    expect(ev.entityId).toBe(INVOICE_ID);
    expect(ev.metadata).toMatchObject({ amountCents: 50000, method: 'bank_transfer' });
  });

  it('is idempotent — a duplicate provider_reference is a no-op (any-row guard), no 2nd audit', async () => {
    await recordProcessingPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'bank_transfer', providerReference: PI, processedBy: 's' },
      paymentRepo,
      auditRepo,
    );
    const second = await recordProcessingPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'bank_transfer', providerReference: PI, processedBy: 's' },
      paymentRepo,
      auditRepo,
    );

    expect(second.created).toBe(false);
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(1);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'payment.processing')).toHaveLength(1);
  });

  it('two concurrent processing inserts create exactly one row (ON CONFLICT backstop)', async () => {
    const fire = () =>
      recordProcessingPayment(
        { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'bank_transfer', providerReference: PI, processedBy: 's' },
        paymentRepo,
        auditRepo,
      );
    const [a, b] = await Promise.all([fire(), fire()]);

    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(1);
    // Exactly one reports created:true.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'payment.processing')).toHaveLength(1);
  });

  it('rejects a missing provider_reference', async () => {
    await expect(
      recordProcessingPayment(
        { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'bank_transfer', providerReference: '', processedBy: 's' },
        paymentRepo,
        auditRepo,
      ),
    ).rejects.toThrow('providerReference is required');
  });
});

describe('settleProcessingPayment', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(50000));
  });

  async function recordProcessing(amountCents = 50000) {
    return recordProcessingPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents, method: 'bank_transfer', providerReference: PI, processedBy: 's' },
      paymentRepo,
      auditRepo,
    );
  }

  it('upgrades processing→completed, marks the invoice paid, INVOKES money-state, fires the receipt ONCE, audits payment.recorded (same as card)', async () => {
    await recordProcessing(50000);
    auditRepo.clear();
    const { deps, findById } = makeMoneyStateDeps(invoiceRepo);
    const receipt = makeReceiptSpy();

    const result = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: PI, settledAmountCents: 50000, correlationId: PI },
      invoiceRepo,
      paymentRepo,
      auditRepo,
      deps,
      receipt,
    );

    expect(result.settled).toBe(true);
    expect(result.payment?.status).toBe('completed');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(50000);
    expect(inv?.amountDueCents).toBe(0);

    // Money-state rollup invoked (R8).
    expect(findById).toHaveBeenCalledTimes(1);
    // Receipt fired exactly once with the applied amount (R8).
    expect(receipt.calls).toEqual([50000]);

    // Audit type parity with the card path: payment.recorded, NOT payment.completed.
    const events = auditRepo.getAll();
    expect(events.find((e) => e.eventType === 'payment.recorded')).toBeDefined();
    expect(events.find((e) => e.eventType === 'payment.completed')).toBeUndefined();
    expect(events.find((e) => e.eventType === 'invoice.status_changed')?.metadata).toMatchObject({
      oldStatus: 'open',
      newStatus: 'paid',
    });
  });

  it('R7 over-collection — processing 500, external 200 lands during the window, settle caps applied to remaining 300', async () => {
    await recordProcessing(50000); // ACH processing $500
    // Owner records a $200 cash payment while ACH is in flight.
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 20000, method: 'cash', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    const invMid = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(invMid?.amountDueCents).toBe(30000); // $300 remaining

    const receipt = makeReceiptSpy();
    const { deps } = makeMoneyStateDeps(invoiceRepo);
    const result = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: PI, settledAmountCents: 50000 }, // Stripe settles $500
      invoiceRepo,
      paymentRepo,
      auditRepo,
      deps,
      receipt,
    );

    expect(result.settled).toBe(true);
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // No overshoot: amountPaid caps at the invoice total, due hits 0.
    expect(inv?.amountPaidCents).toBe(50000);
    expect(inv?.amountDueCents).toBe(0);
    expect(inv?.status).toBe('paid');
    // Receipt + audit reflect the CAPPED amount (300), not the full 500.
    expect(receipt.calls).toEqual([30000]);
  });

  it('amount_received drift — settle uses amount_received and reconciles the row', async () => {
    await recordProcessing(50000); // processing announced $500
    const { deps } = makeMoneyStateDeps(invoiceRepo);

    const result = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: PI, settledAmountCents: 49900 }, // Stripe settles $499 (fee/drift)
      invoiceRepo,
      paymentRepo,
      auditRepo,
      deps,
    );

    expect(result.settled).toBe(true);
    // Row reconciled to amount_received.
    expect(result.payment?.amountCents).toBe(49900);
    const reread = await paymentRepo.findById(TENANT, result.payment!.id);
    expect(reread?.amountCents).toBe(49900);
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(49900);
    expect(inv?.amountDueCents).toBe(100);
    expect(inv?.status).toBe('partially_paid');
  });

  it('double-settle is a no-op (lost CAS) — invoice not double-credited', async () => {
    await recordProcessing(50000);
    const { deps } = makeMoneyStateDeps(invoiceRepo);
    const receipt = makeReceiptSpy();

    const first = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: PI, settledAmountCents: 50000 },
      invoiceRepo, paymentRepo, auditRepo, deps, receipt,
    );
    const second = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: PI, settledAmountCents: 50000 },
      invoiceRepo, paymentRepo, auditRepo, deps, receipt,
    );

    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false); // CAS lost — row already completed
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(50000); // NOT 100000
    expect(inv?.status).toBe('paid');
    expect(receipt.calls).toEqual([50000]); // fired once total
  });

  it('settling an already-paid invoice is an idempotent no-op on the invoice (still reconciles the row)', async () => {
    await recordProcessing(50000);
    // Some other flow fully pays + closes the invoice before ACH clears.
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'cash', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
    );
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    const receipt = makeReceiptSpy();
    const { deps } = makeMoneyStateDeps(invoiceRepo);
    const result = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: PI, settledAmountCents: 50000 },
      invoiceRepo, paymentRepo, auditRepo, deps, receipt,
    );

    // Row settled (completed) but invoice untouched, no receipt, no overpay.
    expect(result.settled).toBe(true);
    expect(result.payment?.status).toBe('completed');
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(50000);
    expect(inv?.status).toBe('paid');
    expect(receipt.calls).toHaveLength(0);
  });

  it('no processing row → settled:false (webhook falls back to card path)', async () => {
    const result = await settleProcessingPayment(
      { tenantId: TENANT, providerReference: 'pi_unknown', settledAmountCents: 50000 },
      invoiceRepo, paymentRepo, auditRepo,
    );
    expect(result.settled).toBe(false);
    expect(result.payment).toBeUndefined();
  });
});

describe('failProcessingPayment', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(50000));
    await recordProcessingPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'bank_transfer', providerReference: PI, processedBy: 's' },
      paymentRepo,
      auditRepo,
    );
    auditRepo.clear();
  });

  it('flips processing→failed, leaves the invoice untouched, audits payment.failed', async () => {
    const result = await failProcessingPayment(
      { tenantId: TENANT, providerReference: PI, reason: 'ach_failed' },
      paymentRepo,
      auditRepo,
    );

    expect(result.failed).toBe(true);
    expect(result.payment?.status).toBe('failed');
    expect(result.payment?.reversalReason).toBe('ach_failed');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(50000);

    expect(auditRepo.getAll().find((e) => e.eventType === 'payment.failed')).toBeDefined();
  });

  it('double-fail is an idempotent no-op (lost CAS)', async () => {
    const first = await failProcessingPayment(
      { tenantId: TENANT, providerReference: PI, reason: 'ach_failed' },
      paymentRepo, auditRepo,
    );
    const second = await failProcessingPayment(
      { tenantId: TENANT, providerReference: PI, reason: 'ach_failed' },
      paymentRepo, auditRepo,
    );
    expect(first.failed).toBe(true);
    expect(second.failed).toBe(false);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'payment.failed')).toHaveLength(1);
  });
});

describe('settle + fail concurrency (CAS mutual exclusion)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(50000));
    await recordProcessingPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 50000, method: 'bank_transfer', providerReference: PI, processedBy: 's' },
      paymentRepo,
      auditRepo,
    );
    auditRepo.clear();
  });

  it('settle + fail fired together → exactly ONE wins, no phantom-paid', async () => {
    const { deps } = makeMoneyStateDeps(invoiceRepo);
    const receipt = makeReceiptSpy();

    const [settleRes, failRes] = await Promise.all([
      settleProcessingPayment(
        { tenantId: TENANT, providerReference: PI, settledAmountCents: 50000 },
        invoiceRepo, paymentRepo, auditRepo, deps, receipt,
      ),
      failProcessingPayment(
        { tenantId: TENANT, providerReference: PI, reason: 'ach_failed' },
        paymentRepo, auditRepo,
      ),
    ]);

    // Exactly one transition won.
    const winners = [settleRes.settled, failRes.failed].filter(Boolean);
    expect(winners).toHaveLength(1);

    const row = (await paymentRepo.findByInvoice(TENANT, INVOICE_ID))[0];
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);

    if (settleRes.settled) {
      // Settle won: row completed, invoice paid, receipt fired once.
      expect(row.status).toBe('completed');
      expect(inv?.status).toBe('paid');
      expect(inv?.amountPaidCents).toBe(50000);
      expect(receipt.calls).toEqual([50000]);
    } else {
      // Fail won: row failed, invoice untouched (NO phantom-paid), no receipt.
      expect(row.status).toBe('failed');
      expect(inv?.status).toBe('open');
      expect(inv?.amountPaidCents).toBe(0);
      expect(receipt.calls).toHaveLength(0);
    }
  });
});

describe('CARD REGRESSION — recordPayment unchanged after helper extraction', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(10000));
  });

  it('full payment: balances/status/audit/money-state/receipt identical to legacy behavior', async () => {
    const { deps, findById } = makeMoneyStateDeps(invoiceRepo);
    const receipt = makeReceiptSpy();

    const { payment, invoice } = await recordPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        method: 'credit_card',
        providerReference: 'pi_card',
        processedBy: 'user-1',
      },
      invoiceRepo,
      paymentRepo,
      deps,
      receipt,
      auditRepo,
      { actorRole: 'owner', correlationId: 'corr-card' },
    );

    expect(payment.status).toBe('completed');
    expect(invoice.amountPaidCents).toBe(10000);
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.status).toBe('paid');

    // Money-state invoked + receipt fired once with the full amount.
    expect(findById).toHaveBeenCalledTimes(1);
    expect(receipt.calls).toEqual([10000]);

    // Audit: payment.recorded carries the same metadata shape as before,
    // plus invoice.status_changed open→paid.
    const events = auditRepo.getAll();
    const recorded = events.find((e) => e.eventType === 'payment.recorded')!;
    expect(recorded.entityType).toBe('invoice');
    expect(recorded.entityId).toBe(INVOICE_ID);
    expect(recorded.actorId).toBe('user-1');
    expect(recorded.actorRole).toBe('owner');
    expect(recorded.correlationId).toBe('corr-card');
    expect(recorded.metadata).toMatchObject({
      amountCents: 10000,
      method: 'credit_card',
      providerReference: 'pi_card',
      newInvoiceStatus: 'paid',
    });
    const sc = events.find((e) => e.eventType === 'invoice.status_changed')!;
    expect(sc.metadata).toMatchObject({ oldStatus: 'open', newStatus: 'paid' });
  });

  it('partial payment: open → partially_paid, single payment.recorded + status_changed', async () => {
    const { payment, invoice } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 4000, method: 'cash', processedBy: 'u1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
    );
    expect(payment.status).toBe('completed');
    expect(invoice.amountPaidCents).toBe(4000);
    expect(invoice.amountDueCents).toBe(6000);
    expect(invoice.status).toBe('partially_paid');

    const events = auditRepo.getAll();
    expect(events.filter((e) => e.eventType === 'payment.recorded')).toHaveLength(1);
    expect(events.find((e) => e.eventType === 'invoice.status_changed')?.metadata).toMatchObject({
      oldStatus: 'open',
      newStatus: 'partially_paid',
    });
    expect(events[0].actorRole).toBe('system'); // defaults preserved
  });

  it('no status_changed when status is unchanged (second partial stays partially_paid)', async () => {
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 3000, method: 'cash', processedBy: 'u1' },
      invoiceRepo, paymentRepo, undefined, undefined, auditRepo,
    );
    auditRepo.clear();
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 2000, method: 'cash', processedBy: 'u1' },
      invoiceRepo, paymentRepo, undefined, undefined, auditRepo,
    );
    const events = auditRepo.getAll();
    expect(events.filter((e) => e.eventType === 'payment.recorded')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'invoice.status_changed')).toHaveLength(0);
  });

  it('still rejects overpayment and non-payable invoices (guards unchanged)', async () => {
    await expect(
      recordPayment(
        { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 20000, method: 'cash', processedBy: 'u1' },
        invoiceRepo,
        paymentRepo,
      ),
    ).rejects.toThrow('Payment amount exceeds amount due');
  });
});
