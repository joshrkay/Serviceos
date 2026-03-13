import {
  recordPayment,
  getPaymentsByInvoice,
  validatePaymentInput,
  InMemoryPaymentRepository,
} from '../../src/invoices/payment';
import {
  createInvoice,
  issueInvoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';

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
    const { transitionInvoiceStatus } = require('../../src/invoices/invoice');
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
