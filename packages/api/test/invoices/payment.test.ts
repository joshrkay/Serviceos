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

    const ref = 'pi_race_123';
    const first = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
    );
    // Second event for the SAME intent → create hits 23505 → idempotent return.
    const second = await recordPayment(
      { tenantId: 'tenant-1', invoiceId: inv.id, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      localInvoiceRepo,
      racingRepo,
    );

    expect(second.payment.id).toBe(first.payment.id); // same row, not a new one
    const rows = await getPaymentsByInvoice('tenant-1', inv.id, inner);
    expect(rows).toHaveLength(1); // no duplicate payment row
    const reloaded = await localInvoiceRepo.findById('tenant-1', inv.id);
    expect(reloaded!.amountPaidCents).toBe(10000); // credited once, not 20000
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
