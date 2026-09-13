import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { PublicInvoiceService } from '../../src/invoices/public-invoice-service';
import { Invoice, InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { Job, InMemoryJobRepository } from '../../src/jobs/job';
import { Customer, InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemorySettingsRepository } from '../../src/settings/settings';

const TENANT = 'tenant-public-invoice-unit';
const VIEW_TOKEN = 'a-very-long-and-unguessable-token-9876';

/**
 * B7.5 (PR review, FINDING B — invoice half) — the descriptive unit
 * reaches the customer on the PAY page, mirroring the estimate-side fix
 * in ea46e5a (test/estimates/public-estimate-service.test.ts).
 *
 * `PublicInvoiceService.toView` rebuilt each line by hand and omitted
 * `unit`, so a customer paying an invoice saw a bare "12" with no way to
 * tell whether the rate was per hour, per lb, or per unit. The field is
 * DESCRIPTIVE: these tests also pin that adding it changes no money on
 * the view.
 */
describe('PublicInvoiceService.toView — B7.5 descriptive unit', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let jobRepo: InMemoryJobRepository;
  let customerRepo: InMemoryCustomerRepository;
  let settingsRepo: InMemorySettingsRepository;
  let service: PublicInvoiceService;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    jobRepo = new InMemoryJobRepository();
    customerRepo = new InMemoryCustomerRepository();
    settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Acme HVAC',
      timezone: 'America/Los_Angeles',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const customer: Customer = {
      id: uuidv4(),
      tenantId: TENANT,
      firstName: 'Sarah',
      lastName: 'Johnson',
      displayName: 'Sarah Johnson',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await customerRepo.create(customer);
    const job: Job = {
      id: uuidv4(),
      tenantId: TENANT,
      customerId: customer.id,
      locationId: uuidv4(),
      jobNumber: 'JOB-0001',
      summary: 'Service',
      status: 'completed',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);
    service = new PublicInvoiceService({
      invoiceRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      paymentRepo,
    });
  });

  async function seedWithUnits(): Promise<Invoice> {
    const job = (await jobRepo.findByTenant(TENANT))[0];
    const invoice: Invoice = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      invoiceNumber: 'INV-0001',
      status: 'open',
      lineItems: [
        {
          id: 'li-hour',
          description: 'Diagnostic labor',
          quantity: 2,
          unit: 'hour',
          unitPriceCents: 9500,
          totalCents: 19000,
          sortOrder: 0,
          taxable: true,
        },
        {
          id: 'li-plain',
          description: 'Service call fee',
          quantity: 1,
          unitPriceCents: 5000,
          totalCents: 5000,
          sortOrder: 1,
          taxable: true,
        },
      ],
      totals: {
        subtotalCents: 24000,
        taxableSubtotalCents: 24000,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents: 24000,
      },
      amountPaidCents: 0,
      amountDueCents: 24000,
      viewToken: VIEW_TOKEN,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await invoiceRepo.create(invoice);
    return invoice;
  }

  it('carries the unit onto the public line-item DTO', async () => {
    await seedWithUnits();
    const view = await service.getByToken(VIEW_TOKEN);
    expect(view.lineItems[0].unit).toBe('hour');
  });

  it('a line with no unit reads back undefined, not null', async () => {
    await seedWithUnits();
    const view = await service.getByToken(VIEW_TOKEN);
    expect(view.lineItems[1].unit).toBeUndefined();
  });

  it('the unit changes no money on the view — totals are unaffected', async () => {
    await seedWithUnits();
    const view = await service.getByToken(VIEW_TOKEN);
    // Same integer cents as the seeded totals; nothing derived from `unit`.
    expect(view.totalCents).toBe(24000);
    expect(view.subtotalCents).toBe(24000);
    expect(view.taxCents).toBe(0);
    const line = view.lineItems[0];
    expect(line.unitPriceCents).toBe(9500);
    expect(line.totalCents).toBe(19000);
    expect(line.quantity * line.unitPriceCents).toBe(line.totalCents);
  });
});
