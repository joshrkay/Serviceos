import {
  recordPayment,
  getPaymentsByInvoice,
  validatePaymentInput,
  InMemoryPaymentRepository,
  type Payment,
  type PaymentRepository,
} from '../../src/invoices/payment';
import {
  createInvoice,
  issueInvoice,
  transitionInvoiceStatus,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-013 — Payment entity + partial payments', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let invoiceId: string;

  const sampleItems = [buildLineItem('1', 'Service', 1, 10000, 1, true)]; // $100

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();

    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      invoiceRepo
    );
    await issueInvoice('tenant-1', invoice.id, 30, invoiceRepo);
    invoiceId = invoice.id;
  });

  it('happy path — records full payment', async () => {
    const { payment, invoice } = await recordPayment(
      {
        tenantId: 'tenant-1',
        invoiceId,
        amountCents: 10000,
        method: 'credit_card',
        processedBy: 'user-1',
      },
      invoiceRepo,
      paymentRepo
    );

    expect(payment.amountCents).toBe(10000);
    expect(payment.status).toBe('completed');
    expect(invoice.amountPaidCents).toBe(10000);
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.status).toBe('paid');
  });

  it('happy path — records partial payment', async () => {
    const { invoice } = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 3000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );

    expect(invoice.amountPaidCents).toBe(3000);
    expect(invoice.amountDueCents).toBe(7000);
    expect(invoice.status).toBe('partially_paid');
  });

  it('happy path — multiple partial payments totaling full amount', async () => {
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 4000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );
    const { invoice } = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 6000, method: 'check', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );

    expect(invoice.amountPaidCents).toBe(10000);
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.status).toBe('paid');
  });

  it('Codex P1 #1: two partial payments on the SAME invoice thread two DISTINCT paymentIds to the receipt notifier (each partial payment gets its own receipt)', async () => {
    const receiptCalls: Array<{ invoiceId: string; amountCents: number; paymentId: string }> = [];
    const notifier = {
      notifyPaymentReceived: async (
        _tenantId: string,
        invId: string,
        amountCents: number,
        paymentId: string,
      ) => {
        receiptCalls.push({ invoiceId: invId, amountCents, paymentId });
      },
    };

    const first = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 4000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      notifier,
    );
    const second = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 6000, method: 'check', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      notifier,
    );

    expect(receiptCalls).toHaveLength(2);
    expect(receiptCalls[0].paymentId).toBe(first.payment.id);
    expect(receiptCalls[1].paymentId).toBe(second.payment.id);
    // The two payments (hence their receipt claim tokens) are distinct —
    // an invoice-scoped-only claim key would have tombstoned the SECOND
    // receipt after the first.
    expect(receiptCalls[0].paymentId).not.toBe(receiptCalls[1].paymentId);
  });

  it('payment arithmetic — partial payments keep running balance correct', async () => {
    const first = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 2500, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );
    expect(first.invoice.amountPaidCents).toBe(2500);
    expect(first.invoice.amountDueCents).toBe(7500);
    expect(first.invoice.status).toBe('partially_paid');

    const second = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 2500, method: 'check', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );
    expect(second.invoice.amountPaidCents).toBe(5000);
    expect(second.invoice.amountDueCents).toBe(5000);
    expect(second.invoice.status).toBe('partially_paid');
  });

  it('happy path — retrieves payments for invoice', async () => {
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 3000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 2000, method: 'check', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );

    const payments = await getPaymentsByInvoice('tenant-1', invoiceId, paymentRepo);
    expect(payments).toHaveLength(2);
  });

  it('duplicate-payment race backstop — a 23505 on the same Stripe reference is idempotent (no double credit)', async () => {
    // Simulate migration 229's partial unique index: a second Stripe payment
    // row for the same (tenant, reference) is rejected with SQLSTATE 23505.
    // The InMemory repo preserves all rows and can't reproduce the constraint
    // (mocked-DB trap), so wrap it. Invoice is $200 so a second $100 payment is
    // still payable — mirroring two concurrent webhook events that both read
    // the invoice as still-open before either commits.
    const localInvoiceRepo = new InMemoryInvoiceRepository();
    const inner = new InMemoryPaymentRepository();
    const seen = new Set<string>();
    const racingRepo: PaymentRepository = {
      create: async (p: Payment) => {
        if (p.providerReference && (p.method === 'credit_card' || p.method === 'bank_transfer')) {
          const key = `${p.tenantId}:${p.providerReference}`;
          if (seen.has(key)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          seen.add(key);
        }
        return inner.create(p);
      },
      findByProviderReference: (t: string, r: string) => inner.findByProviderReference(t, r),
      findByInvoice: (t: string, i: string) => inner.findByInvoice(t, i),
    } as unknown as PaymentRepository;

    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-DUP',
        lineItems: [buildLineItem('1', 'Service', 1, 20000, 1, true)],
        createdBy: 'u-1',
      },
      localInvoiceRepo,
    );
    await issueInvoice('tenant-1', inv.id, 30, localInvoiceRepo);

    // Count customer receipts — a pure duplicate must NOT fire a second one.
    let receipts = 0;
    const notifier = { notifyPaymentReceived: async () => { receipts += 1; } };

    const ref = 'pi_race_123';
    const first = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
      undefined,
      notifier,
    );
    // Second event for the SAME intent → create hits 23505 → idempotent return.
    const second = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
      undefined,
      notifier,
    );

    expect(second.payment.id).toBe(first.payment.id); // same row, not a new one
    const rows = await getPaymentsByInvoice('tenant-1', inv.id, inner);
    expect(rows).toHaveLength(1); // no duplicate payment row
    const reloaded = await localInvoiceRepo.findById('tenant-1', inv.id);
    expect(reloaded!.amountPaidCents).toBe(10000); // credited once, not 20000
    expect(receipts).toBe(1); // receipt fired once, NOT on the duplicate
  });

  it('duplicate-payment backstop — reconciles an invoice under-credited by a crashed prior attempt', async () => {
    // The winning attempt committed the payment row but crashed before crediting
    // the invoice (payment.create and invoice.update are separate transactions
    // on the webhook path). A bare idempotent return would leave the invoice
    // permanently underpaid; the 23505 branch must repair it from the ledger.
    const localInvoiceRepo = new InMemoryInvoiceRepository();
    const inner = new InMemoryPaymentRepository();
    const seen = new Set<string>();
    const racingRepo: PaymentRepository = {
      create: async (p: Payment) => {
        if (p.providerReference && (p.method === 'credit_card' || p.method === 'bank_transfer')) {
          const key = `${p.tenantId}:${p.providerReference}`;
          if (seen.has(key)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          seen.add(key);
        }
        return inner.create(p);
      },
      findByProviderReference: (t: string, r: string) => inner.findByProviderReference(t, r),
      findByInvoice: (t: string, i: string) => inner.findByInvoice(t, i),
    } as unknown as PaymentRepository;

    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-CRASH',
        lineItems: [buildLineItem('1', 'Service', 1, 20000, 1, true)],
        createdBy: 'u-1',
      },
      localInvoiceRepo,
    );
    await issueInvoice('tenant-1', inv.id, 30, localInvoiceRepo);

    // Spy on the post-payment side effects — they must RE-RUN on the repair
    // (the crashed attempt never reached them), unlike a pure duplicate.
    let receipts = 0;
    const notifier = { notifyPaymentReceived: async () => { receipts += 1; } };
    let auditEvents = 0;
    const auditSpy = { create: async () => { auditEvents += 1; } };

    const ref = 'pi_crash_1';
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
      undefined,
      notifier,
      auditSpy as never,
    );
    const receiptsAfterFirst = receipts;
    const auditAfterFirst = auditEvents;
    // Simulate the crash: payment row is committed, but the invoice credit was
    // lost (rolled back / never applied).
    await localInvoiceRepo.update('tenant-1', inv.id, {
      amountPaidCents: 0,
      amountDueCents: 20000,
      status: 'open',
      updatedAt: new Date(),
    });

    // Retry the same intent → create hits 23505 → reconcile repairs the invoice.
    const retry = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
      undefined,
      notifier,
      auditSpy as never,
    );

    expect(retry.invoice.amountPaidCents).toBe(10000);
    expect(retry.invoice.amountDueCents).toBe(10000);
    expect(retry.invoice.status).toBe('partially_paid');
    // Still exactly one payment row.
    expect(await getPaymentsByInvoice('tenant-1', inv.id, inner)).toHaveLength(1);
    // The repair re-ran the receipt + audit the crashed attempt never reached.
    expect(receipts).toBe(receiptsAfterFirst + 1);
    expect(auditEvents).toBeGreaterThan(auditAfterFirst);
  });

  it('duplicate-payment backstop — a reference reused on a DIFFERENT invoice is a conflict, not idempotent', async () => {
    // The 23505 backstop must only short-circuit for the same invoice. If the
    // same reference lands on another invoice, returning the first invoice's
    // payment would leave the requested invoice unpaid — surface a conflict.
    const localInvoiceRepo = new InMemoryInvoiceRepository();
    const inner = new InMemoryPaymentRepository();
    const seen = new Set<string>();
    const racingRepo: PaymentRepository = {
      create: async (p: Payment) => {
        if (p.providerReference && (p.method === 'credit_card' || p.method === 'bank_transfer')) {
          // Index is on (tenant, reference) — NOT scoped to invoice.
          const key = `${p.tenantId}:${p.providerReference}`;
          if (seen.has(key)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          seen.add(key);
        }
        return inner.create(p);
      },
      findByProviderReference: (t: string, r: string) => inner.findByProviderReference(t, r),
      findByInvoice: (t: string, i: string) => inner.findByInvoice(t, i),
    } as unknown as PaymentRepository;

    const mkInvoice = async (num: string) => {
      const i = await createInvoice(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          invoiceNumber: num,
          lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
          createdBy: 'u-1',
        },
        localInvoiceRepo,
      );
      await issueInvoice('tenant-1', i.id, 30, localInvoiceRepo);
      return i;
    };
    const invA = await mkInvoice('INV-A');
    const invB = await mkInvoice('INV-B');

    const ref = 'pi_shared_ref';
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId: invA.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'u-1' },
      localInvoiceRepo,
      racingRepo,
    );

    // Same reference, DIFFERENT invoice → conflict, not a silent idempotent return.
    await expect(
      recordPayment(
        { tenantId: 'tenant-1', invoiceId: invB.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'u-1' },
        localInvoiceRepo,
        racingRepo,
      ),
    ).rejects.toThrow(/different invoice/i);

    // Invoice B stays unpaid (not silently marked paid via A's payment).
    const b = await localInvoiceRepo.findById('tenant-1', invB.id);
    expect(b!.amountPaidCents).toBe(0);
  });

  it('validation — rejects overpayment', async () => {
    await expect(
      recordPayment(
        { tenantId: 'tenant-1', invoiceId, amountCents: 20000, method: 'cash', processedBy: 'u-1' },
        invoiceRepo,
        paymentRepo
      )
    ).rejects.toThrow('Payment amount exceeds amount due');
  });

  it('validation — rejects zero/negative amount', () => {
    const errors = validatePaymentInput({
      tenantId: 'tenant-1',
      invoiceId: 'inv-1',
      amountCents: 0,
      method: 'cash',
      processedBy: 'u-1',
    });
    expect(errors).toContain('amountCents must be positive');
  });

  it('validation — rejects non-integer amount', () => {
    const errors = validatePaymentInput({
      tenantId: 'tenant-1',
      invoiceId: 'inv-1',
      amountCents: 10.5,
      method: 'cash',
      processedBy: 'u-1',
    });
    expect(errors).toContain('amountCents must be an integer');
  });

  it('validation — rejects invalid payment method', () => {
    const errors = validatePaymentInput({
      tenantId: 'tenant-1',
      invoiceId: 'inv-1',
      amountCents: 1000,
      method: 'bitcoin' as any,
      processedBy: 'u-1',
    });
    expect(errors).toContain('Invalid payment method');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validatePaymentInput({
      tenantId: '',
      invoiceId: '',
      amountCents: 0,
      method: '' as any,
      processedBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('invoiceId is required');
  });

  it('validation — rejects invalid payload before invoice lookup with aggregated message', async () => {
    await expect(
      recordPayment(
        {
          tenantId: '',
          invoiceId: 'missing-invoice',
          amountCents: 0,
          method: '' as any,
          processedBy: '',
        },
        invoiceRepo,
        paymentRepo
      )
    ).rejects.toThrow(
      'Validation failed: tenantId is required, amountCents must be positive, method is required, processedBy is required'
    );
  });

  it('validation — rejects payment on draft invoice', async () => {
    // Create a new invoice but do NOT issue it (stays in draft)
    const draftInvoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-DRAFT', lineItems: sampleItems, createdBy: 'u-1' },
      invoiceRepo
    );

    await expect(
      recordPayment(
        { tenantId: 'tenant-1', invoiceId: draftInvoice.id, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
        invoiceRepo,
        paymentRepo
      )
    ).rejects.toThrow("Cannot record payment on invoice with status 'draft'");
  });

  it('validation — rejects payment on void invoice', async () => {
    // Void the issued invoice
    await transitionInvoiceStatus('tenant-1', invoiceId, 'void', invoiceRepo);

    await expect(
      recordPayment(
        { tenantId: 'tenant-1', invoiceId, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
        invoiceRepo,
        paymentRepo
      )
    ).rejects.toThrow("Cannot record payment on invoice with status 'void'");
  });

  it('tenant isolation — cross-tenant payment inaccessible', async () => {
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 5000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo
    );

    const crossTenant = await getPaymentsByInvoice('tenant-2', invoiceId, paymentRepo);
    expect(crossTenant).toHaveLength(0);
  });
});

describe('Blocker 6 — recordPayment emits audit events', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let invoiceId: string;

  const sampleItems = [buildLineItem('1', 'Service', 1, 10000, 1, true)]; // $100

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();

    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      invoiceRepo
    );
    await issueInvoice('tenant-1', invoice.id, 30, invoiceRepo);
    invoiceId = invoice.id;
  });

  it('emits payment.recorded + invoice.status_changed on a full payment', async () => {
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 10000, method: 'credit_card', processedBy: 'user-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
      { actorRole: 'owner', correlationId: 'corr-1' },
    );

    const events = auditRepo.getAll();
    const recorded = events.find((e) => e.eventType === 'payment.recorded');
    expect(recorded).toBeDefined();
    expect(recorded!.entityType).toBe('invoice');
    expect(recorded!.entityId).toBe(invoiceId);
    expect(recorded!.actorId).toBe('user-1');
    expect(recorded!.actorRole).toBe('owner');
    expect(recorded!.correlationId).toBe('corr-1');
    expect(recorded!.metadata).toMatchObject({ amountCents: 10000, method: 'credit_card' });

    const statusChange = events.find((e) => e.eventType === 'invoice.status_changed');
    expect(statusChange).toBeDefined();
    expect(statusChange!.metadata).toMatchObject({ oldStatus: 'open', newStatus: 'paid' });
  });

  it('audits the open → partially_paid transition on a partial payment', async () => {
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 4000, method: 'cash', processedBy: 'user-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
      { actorRole: 'owner', correlationId: 'corr-partial' },
    );

    const events = auditRepo.getAll();
    const recorded = events.find((e) => e.eventType === 'payment.recorded');
    expect(recorded).toBeDefined();
    expect(recorded!.metadata).toMatchObject({
      amountCents: 4000,
      method: 'cash',
      newInvoiceStatus: 'partially_paid',
    });

    const statusChange = events.find((e) => e.eventType === 'invoice.status_changed');
    expect(statusChange).toBeDefined();
    expect(statusChange!.metadata).toMatchObject({ oldStatus: 'open', newStatus: 'partially_paid' });
    expect(statusChange!.correlationId).toBe('corr-partial');
  });

  it('defaults actorRole to system and emits no status_changed when status is unchanged', async () => {
    // A partial payment of an already partially_paid invoice keeps status
    // 'partially_paid' on the second call → no status_changed event.
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 3000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo, paymentRepo, undefined, undefined, auditRepo,
    );
    auditRepo.clear();
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 2000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo, paymentRepo, undefined, undefined, auditRepo,
    );

    const events = auditRepo.getAll();
    expect(events.filter((e) => e.eventType === 'payment.recorded')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'invoice.status_changed')).toHaveLength(0);
    expect(events[0].actorRole).toBe('system');
  });

  it('emits nothing when no auditRepo is provided (backward compatible)', async () => {
    const { payment } = await recordPayment(
      { tenantId: 'tenant-1', invoiceId, amountCents: 10000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
    );
    expect(payment.amountCents).toBe(10000);
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('P0-3 / P0-6 — atomic credit guards (live-state predicates)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let invoiceId: string;

  const sampleItems = [buildLineItem('1', 'Service', 1, 10000, 1, true)]; // $100

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      invoiceRepo
    );
    await issueInvoice('tenant-1', invoice.id, 30, invoiceRepo);
    invoiceId = invoice.id;
  });

  it('incrementAmountPaidAtomic returns null on a void invoice (void can never flip to paid)', async () => {
    await transitionInvoiceStatus('tenant-1', invoiceId, 'void', invoiceRepo);

    const result = await invoiceRepo.incrementAmountPaidAtomic('tenant-1', invoiceId, 10000, new Date());

    expect(result).toBeNull();
    const reloaded = await invoiceRepo.findById('tenant-1', invoiceId);
    expect(reloaded!.status).toBe('void');
    expect(reloaded!.amountPaidCents).toBe(0);
  });

  it('incrementAmountPaidAtomic returns null when the credit would exceed total_cents', async () => {
    const first = await invoiceRepo.incrementAmountPaidAtomic('tenant-1', invoiceId, 10000, new Date());
    expect(first!.status).toBe('paid');

    const second = await invoiceRepo.incrementAmountPaidAtomic('tenant-1', invoiceId, 10000, new Date());

    expect(second).toBeNull();
    const reloaded = await invoiceRepo.findById('tenant-1', invoiceId);
    expect(reloaded!.amountPaidCents).toBe(10000); // never 2x total
  });

  it('two concurrent full-balance payments: exactly one credits; the loser is compensated to failed', async () => {
    const mkInput = (ref: string) => ({
      tenantId: 'tenant-1',
      invoiceId,
      amountCents: 10000,
      method: 'credit_card' as const,
      providerReference: ref,
      processedBy: 'u-1',
    });

    // Both pass the serial check-then-act guards against the same snapshot;
    // the SQL-mirror predicate must reject the second credit.
    const results = await Promise.allSettled([
      recordPayment(mkInput('pi_race_a'), invoiceRepo, paymentRepo, undefined, undefined, auditRepo),
      recordPayment(mkInput('pi_race_b'), invoiceRepo, paymentRepo, undefined, undefined, auditRepo),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /exceeds amount due|status 'paid'/,
    );

    // The invoice is paid exactly once — the double-charge is structurally impossible.
    const reloaded = await invoiceRepo.findById('tenant-1', invoiceId);
    expect(reloaded!.amountPaidCents).toBe(10000);
    expect(reloaded!.amountDueCents).toBe(0);
    expect(reloaded!.status).toBe('paid');

    // The loser's payment row was compensated to 'failed', so every
    // paid-ledger sum (completed|processing, !reversed) still equals the credit.
    const payments = await paymentRepo.findByInvoice('tenant-1', invoiceId);
    expect(payments).toHaveLength(2);
    expect(payments.filter((p) => p.status === 'completed')).toHaveLength(1);
    const failed = payments.find((p) => p.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.reversalReason).toBe('credit_rejected');

    // The compensation is on the audit trail.
    const rejectedEvents = auditRepo.getAll().filter((e) => e.eventType === 'payment.credit_rejected');
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0].metadata?.paymentId).toBe(failed!.id);
  });
});

describe('P0-7 — crash-repair reconciler is refund-INCLUSIVE and void-safe', () => {
  // Shared shape with the duplicate-payment backstop tests: a wrapped repo
  // reproduces migration 229's unique index so a retried reference hits the
  // 23505 → reconcile branch.
  function makeRacingRepos() {
    const localInvoiceRepo = new InMemoryInvoiceRepository();
    const inner = new InMemoryPaymentRepository();
    const seen = new Set<string>();
    const racingRepo: PaymentRepository = {
      create: async (p: Payment) => {
        if (p.providerReference && (p.method === 'credit_card' || p.method === 'bank_transfer')) {
          const key = `${p.tenantId}:${p.providerReference}`;
          if (seen.has(key)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          seen.add(key);
        }
        return inner.create(p);
      },
      findByProviderReference: (t: string, r: string) => inner.findByProviderReference(t, r),
      findByInvoice: (t: string, i: string) => inner.findByInvoice(t, i),
      update: (t: string, id: string, u: Partial<Payment>) => inner.update(t, id, u),
    } as unknown as PaymentRepository;
    return { localInvoiceRepo, inner, racingRepo };
  }

  async function createOpenInvoice(repo: InMemoryInvoiceRepository, totalCents: number) {
    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: `INV-P07-${totalCents}`,
        lineItems: [buildLineItem('1', 'Service', 1, totalCents, 1, true)],
        createdBy: 'u-1',
      },
      repo,
    );
    await issueInvoice('tenant-1', inv.id, 30, repo);
    return inv;
  }

  it('repairs to the FULL payment amount even when the payment carries a partial refund', async () => {
    const { localInvoiceRepo, inner, racingRepo } = makeRacingRepos();
    const inv = await createOpenInvoice(localInvoiceRepo, 20000);

    const ref = 'pi_refund_inclusive_1';
    const { payment } = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
    );

    // Crash: the credit is lost; meanwhile a $30 partial refund lands on the row.
    await localInvoiceRepo.update('tenant-1', inv.id, {
      amountPaidCents: 0,
      amountDueCents: 20000,
      status: 'open',
      updatedAt: new Date(),
    });
    await inner.update('tenant-1', payment.id, { refundedAmountCents: 3000 });

    const retry = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
    );

    // The stated invariant is refund-inclusive: amount_paid == Σ(active
    // payments.amount_cents) == 10000. The old refund-net repair wrote 7000,
    // silently diverging from every other writer of the column.
    expect(retry.invoice.amountPaidCents).toBe(10000);
    expect(retry.invoice.amountDueCents).toBe(10000);
  });

  it('never resurrects a voided invoice — the repair is scoped to payable statuses', async () => {
    // The serial guard already rejects a retry on an ALREADY-void invoice; the
    // repair-path hole only opens when the void lands BETWEEN the payable check
    // and the duplicate insert. Reproduce that interleave: the wrapped create
    // voids the invoice at the moment it raises the 23505, so the reconcile
    // branch runs against a live-void row.
    const localInvoiceRepo = new InMemoryInvoiceRepository();
    const inner = new InMemoryPaymentRepository();
    const seen = new Set<string>();
    let voidOnDuplicate: (() => Promise<void>) | null = null;
    const racingRepo: PaymentRepository = {
      create: async (p: Payment) => {
        if (p.providerReference) {
          const key = `${p.tenantId}:${p.providerReference}`;
          if (seen.has(key)) {
            if (voidOnDuplicate) await voidOnDuplicate();
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          seen.add(key);
        }
        return inner.create(p);
      },
      findByProviderReference: (t: string, r: string) => inner.findByProviderReference(t, r),
      findByInvoice: (t: string, i: string) => inner.findByInvoice(t, i),
      update: (t: string, id: string, u: Partial<Payment>) => inner.update(t, id, u),
    } as unknown as PaymentRepository;

    const inv = await createOpenInvoice(localInvoiceRepo, 20000);
    const ref = 'pi_void_norepair_1';
    await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
    );

    // Crash-lost credit: the row exists but the invoice was never credited.
    await localInvoiceRepo.update('tenant-1', inv.id, {
      amountPaidCents: 0,
      amountDueCents: 20000,
      status: 'open',
      updatedAt: new Date(),
    });
    voidOnDuplicate = async () => {
      await transitionInvoiceStatus('tenant-1', inv.id, 'void', localInvoiceRepo);
    };

    // A late redelivery of the same intent must NOT flip void back to
    // partially_paid — that is P0-3's forbidden transition via the repair path.
    const retry = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
    );

    expect(retry.invoice.status).toBe('void');
    expect(retry.invoice.amountPaidCents).toBe(0);
    const reloaded = await localInvoiceRepo.findById('tenant-1', inv.id);
    expect(reloaded!.status).toBe('void');
  });
});

describe('R1 — compensation must not orphan a reconciler-credited payment', () => {
  it('returns success (no failed flip) when the invoice balance already reflects this row', async () => {
    // Race: our payment row committed; a concurrent duplicate delivery hit
    // the 23505 branch and reconciled the invoice FROM THE LEDGER (which
    // includes our row) before our own increment ran. The increment then
    // matches 0 rows because the invoice is already paid — with OUR money.
    // Flipping our row to 'failed' would leave invoice paid over an empty
    // active ledger.
    const inner = new InMemoryInvoiceRepository();
    const paymentRepo = new InMemoryPaymentRepository();
    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-R1',
        lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      inner,
    );
    await issueInvoice('tenant-1', inv.id, 30, inner);

    // Wrap the invoice repo: the first increment "loses" — and at that
    // moment the reconciler has already written the credited balance.
    let intercepted = false;
    const racingInvoiceRepo = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'incrementAmountPaidAtomic' && !intercepted) {
          return async () => {
            intercepted = true;
            // Simulate the concurrent reconcile: balance written from the
            // ledger (which contains our just-committed row).
            await inner.update('tenant-1', inv.id, {
              amountPaidCents: 10000,
              amountDueCents: 0,
              status: 'paid',
              updatedAt: new Date(),
            });
            return null; // our own UPDATE matched 0 rows
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = await recordPayment(
      {
        tenantId: 'tenant-1',
        invoiceId: inv.id,
        amountCents: 10000,
        method: 'credit_card',
        providerReference: 'pi_r1_race',
        processedBy: 'stripe_webhook',
      },
      racingInvoiceRepo,
      paymentRepo,
    );

    // Success, not a throw — and the row stays 'completed' so
    // invoice.amount_paid == Σ(active payments) still holds.
    expect(result.invoice.status).toBe('paid');
    const rows = await paymentRepo.findByInvoice('tenant-1', inv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
  });
});

describe('P0-3 reconciler leg — the repair WRITE is status-guarded, not just the read', () => {
  it('a void committing between the reconciler read and write is never resurrected', async () => {
    const inner = new InMemoryInvoiceRepository();
    const paymentRepo = new InMemoryPaymentRepository();
    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-RACE-RECON',
        lineItems: [buildLineItem('1', 'Service', 1, 20000, 1, true)],
        createdBy: 'u-1',
      },
      inner,
    );
    await issueInvoice('tenant-1', inv.id, 30, inner);

    // A completed payment row exists but the credit was crash-lost.
    await paymentRepo.create({
      id: 'pay-recon-1',
      tenantId: 'tenant-1',
      invoiceId: inv.id,
      amountCents: 10000,
      method: 'credit_card',
      status: 'completed',
      providerReference: 'pi_recon_race',
      receivedAt: new Date(),
      processedBy: 'stripe_webhook',
      createdAt: new Date(),
      updatedAt: new Date(),
      refundedAmountCents: 0,
      refundedAt: null,
      lastRefundStripeId: null,
      reversedAt: null,
      reversalReason: null,
    } as Payment);

    // The reconciler's own findById returns the STALE open snapshot; the
    // void commits immediately after that read, before the repair write.
    let staleServed = false;
    const racingInvoiceRepo = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'findById' && !staleServed) {
          return async (tenantId: string, id: string) => {
            staleServed = true;
            const snapshot = await inner.findById(tenantId, id); // open
            await transitionInvoiceStatus(tenantId, id, 'void', inner);
            return snapshot;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Drive the reconcile branch via a duplicate insert (23505).
    const dupRepo: PaymentRepository = {
      create: async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      },
      findByProviderReference: (t: string, r: string) => paymentRepo.findByProviderReference(t, r),
      findByInvoice: (t: string, i: string) => paymentRepo.findByInvoice(t, i),
      update: (t: string, id: string, u: Partial<Payment>) => paymentRepo.update(t, id, u),
    } as unknown as PaymentRepository;

    const retry = await recordPayment(
      {
        tenantId: 'tenant-1',
        invoiceId: inv.id,
        amountCents: 10000,
        method: 'credit_card',
        providerReference: 'pi_recon_race',
        processedBy: 'stripe_webhook',
      },
      racingInvoiceRepo,
      dupRepo,
    );

    // The atomic repair matched 0 rows: the invoice stays void, unrepaired.
    const reloaded = await inner.findById('tenant-1', inv.id);
    expect(reloaded!.status).toBe('void');
    expect(reloaded!.amountPaidCents).toBe(0);
    expect(retry.invoice.status).toBe('void');
  });
});

describe('P0-9 centralized — recordPayment itself kills a link its credit made stale', () => {
  it('deactivates the stored link (settled) on any entry point that passes cleanup deps', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const paymentRepo = new InMemoryPaymentRepository();
    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-CENTRAL-1',
        lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice('tenant-1', inv.id, 30, invoiceRepo);
    await invoiceRepo.update('tenant-1', inv.id, {
      stripePaymentLinkId: 'plink_central_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/central1',
      updatedAt: new Date(),
    });

    const deactivated: string[] = [];
    const cleanup = {
      provider: {
        generateLink: async () => { throw new Error('not used'); },
        deactivateLink: async (linkId: string) => { deactivated.push(linkId); },
      },
    };

    // A cash credit through ANY caller (route, webhook, voice proposal,
    // dues collector) — the cleanup now lives inside recordPayment.
    const { invoice } = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'cash', processedBy: 'u-1' },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cleanup,
    );

    expect(invoice.status).toBe('paid');
    expect(deactivated).toEqual(['plink_central_1']);
    const reloaded = await invoiceRepo.findById('tenant-1', inv.id);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
  });
});

describe('Codex P1 — stale-link cleanup precedes fallible side effects', () => {
  it('a throwing audit write does not leave the stale link live', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const paymentRepo = new InMemoryPaymentRepository();
    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-ORDER-1',
        lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice('tenant-1', inv.id, 30, invoiceRepo);
    await invoiceRepo.update('tenant-1', inv.id, {
      stripePaymentLinkId: 'plink_order_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/order1',
      updatedAt: new Date(),
    });

    const deactivated: string[] = [];
    const cleanup = {
      provider: {
        generateLink: async () => { throw new Error('not used'); },
        deactivateLink: async (linkId: string) => { deactivated.push(linkId); },
      },
    };
    // The proposal-execution failure mode: the credit commits, then the
    // audit write rejects. The retry will hit the paid-status guard and
    // never reach cleanup — so cleanup must already have run.
    const throwingAudit = {
      create: async () => { throw new Error('audit store down'); },
    };

    await expect(
      recordPayment(
        { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'cash', processedBy: 'u-1' },
        invoiceRepo,
        paymentRepo,
        undefined,
        undefined,
        throwingAudit as never,
        undefined,
        undefined,
        cleanup,
      ),
    ).rejects.toThrow('audit store down');

    // The credit landed and the link died BEFORE the side effect threw.
    const reloaded = await invoiceRepo.findById('tenant-1', inv.id);
    expect(reloaded!.status).toBe('paid');
    expect(deactivated).toEqual(['plink_order_1']);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
  });
});
