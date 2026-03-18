import {
  createInvoice,
  getInvoice,
  updateInvoice,
  issueInvoice,
  transitionInvoiceStatus,
  isValidInvoiceTransition,
  validateInvoiceInput,
  recalculateBalance,
  calculateDueDate,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('P1-011 — Invoice entity + balance calculations', () => {
  let repo: InMemoryInvoiceRepository;

  const sampleItems = [
    buildLineItem('1', 'AC Repair', 2, 7500, 1, true, 'labor'),
    buildLineItem('2', 'Parts', 1, 5000, 2, true, 'material'),
  ];

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
  });

  it('happy path — creates invoice with calculated totals and balance', async () => {
    const invoice = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-0001',
        lineItems: sampleItems,
        taxRateBps: 825,
        createdBy: 'user-1',
      },
      repo
    );

    expect(invoice.id).toBeTruthy();
    expect(invoice.status).toBe('draft');
    expect(invoice.amountPaidCents).toBe(0);
    expect(invoice.amountDueCents).toBe(invoice.totals.totalCents);
    expect(invoice.totals.subtotalCents).toBe(20000);
  });

  it('happy path — retrieves invoice', async () => {
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    const found = await getInvoice('tenant-1', invoice.id, repo);
    expect(found).not.toBeNull();
    expect(found!.lineItems).toHaveLength(2);
  });

  it('happy path — recalculates balance', () => {
    const invoice = {
      id: 'inv-1',
      tenantId: 'tenant-1',
      jobId: 'job-1',
      invoiceNumber: 'INV-0001',
      status: 'open' as const,
      lineItems: sampleItems,
      totals: { subtotalCents: 20000, discountCents: 0, taxRateBps: 0, taxableSubtotalCents: 20000, taxCents: 0, totalCents: 20000 },
      amountPaidCents: 5000,
      amountDueCents: 0,
      createdBy: 'u-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const recalculated = recalculateBalance(invoice);
    expect(recalculated.amountDueCents).toBe(15000);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateInvoiceInput({
      tenantId: '',
      jobId: '',
      invoiceNumber: '',
      lineItems: [],
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('jobId is required');
    expect(errors).toContain('invoiceNumber is required');
    expect(errors).toContain('At least one line item is required');
  });

  it('validation — createInvoice surfaces validator errors', async () => {
    await expect(
      createInvoice(
        {
          tenantId: 'tenant-1',
          jobId: 'job-1',
          invoiceNumber: 'INV-0001',
          lineItems: [],
          createdBy: 'u-1',
        },
        repo
      )
    ).rejects.toThrow('Validation failed: At least one line item is required');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    const found = await getInvoice('tenant-2', invoice.id, repo);
    expect(found).toBeNull();
  });

  it('zero amount edge case — zero value invoice', async () => {
    const zeroItems = [buildLineItem('z-1', 'Free service', 1, 0, 1, true)];
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: zeroItems, createdBy: 'u-1' },
      repo
    );
    expect(invoice.totals.totalCents).toBe(0);
    expect(invoice.amountDueCents).toBe(0);
  });

  it('rounding boundary — fractional quantities', async () => {
    const items = [buildLineItem('1', 'Labor', 1.5, 7500, 1, true)];
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: items, taxRateBps: 825, createdBy: 'u-1' },
      repo
    );
    expect(Number.isInteger(invoice.totals.taxCents)).toBe(true);
  });
});

describe('P1-012 — Invoice numbering + due dates + statuses', () => {
  let repo: InMemoryInvoiceRepository;
  const sampleItems = [buildLineItem('1', 'Service', 1, 10000, 1, true)];

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
  });

  it('happy path — issues invoice with due date', async () => {
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    const issued = await issueInvoice('tenant-1', invoice.id, 30, repo);
    expect(issued!.status).toBe('open');
    expect(issued!.issuedAt).toBeTruthy();
    expect(issued!.dueDate).toBeTruthy();
  });

  it('happy path — calculates due date correctly', () => {
    const issuedAt = new Date('2026-01-15');
    const dueDate = calculateDueDate(issuedAt, 30);
    expect(dueDate.getDate()).toBe(14); // Feb 14
    expect(dueDate.getMonth()).toBe(1); // February
  });

  it('happy path — transitions open to void', async () => {
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );
    await issueInvoice('tenant-1', invoice.id, 30, repo);

    const voided = await transitionInvoiceStatus('tenant-1', invoice.id, 'void', repo);
    expect(voided!.status).toBe('void');
  });

  it('validation — rejects invalid status transition', async () => {
    const invoice = await createInvoice(
      { tenantId: 'tenant-1', jobId: 'job-1', invoiceNumber: 'INV-0001', lineItems: sampleItems, createdBy: 'u-1' },
      repo
    );

    await expect(
      transitionInvoiceStatus('tenant-1', invoice.id, 'paid', repo)
    ).rejects.toThrow('Invalid transition from draft to paid');
  });

  it('validation — paid and void are terminal', () => {
    expect(isValidInvoiceTransition('paid', 'open')).toBe(false);
    expect(isValidInvoiceTransition('void', 'open')).toBe(false);
  });
});
