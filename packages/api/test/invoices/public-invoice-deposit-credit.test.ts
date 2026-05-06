import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { PublicInvoiceService } from '../../src/invoices/public-invoice-service';
import {
  Invoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { Job, InMemoryJobRepository } from '../../src/jobs/job';
import { Customer, InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { applyDepositCreditToInvoice } from '../../src/invoices/deposit-credit';

const TENANT = 'tenant-public-invoice-credit';

/**
 * Tier 4 (Deposit rules — PR 3c). Asserts that PublicInvoiceService
 * surfaces depositCreditCents on the public view by summing payments
 * tagged providerReference='deposit_credit'. Combined with the
 * `applyDepositCreditToInvoice` unit tests this locks the round-trip
 * customer-page behavior.
 */
describe('PublicInvoiceService — surfaces depositCreditCents (PR 3c)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let jobRepo: InMemoryJobRepository;
  let customerRepo: InMemoryCustomerRepository;
  let settingsRepo: InMemorySettingsRepository;
  let service: PublicInvoiceService;
  const VIEW_TOKEN = 'a-very-long-and-unguessable-token-1234';

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
      depositRequiredCents: 25000,
      depositPaidCents: 25000,
      depositStatus: 'paid',
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

  function makeInvoice(jobId: string, totalCents: number): Invoice {
    return {
      id: uuidv4(),
      tenantId: TENANT,
      jobId,
      invoiceNumber: 'INV-0001',
      status: 'open',
      lineItems: [
        {
          id: uuidv4(),
          description: 'Service',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: true,
        },
      ],
      totals: {
        subtotalCents: totalCents,
        taxableSubtotalCents: totalCents,
        discountCents: 0,
        taxRateBps: 0,
        taxCents: 0,
        totalCents,
      },
      amountPaidCents: 0,
      amountDueCents: totalCents,
      viewToken: VIEW_TOKEN,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('surfaces depositCreditCents = sum(payments where providerReference == deposit_credit)', async () => {
    const job = (await jobRepo.findByTenant(TENANT))[0];
    const invoice = makeInvoice(job.id, 100000);
    await invoiceRepo.create(invoice);
    await applyDepositCreditToInvoice(invoice, job, invoiceRepo, paymentRepo, jobRepo);

    const view = await service.getByToken(VIEW_TOKEN);
    expect(view.depositCreditCents).toBe(25000);
    expect(view.amountPaidCents).toBe(25000);
    expect(view.amountDueCents).toBe(75000);
  });

  it('depositCreditCents = 0 when no deposit_credit payments exist', async () => {
    const job = (await jobRepo.findByTenant(TENANT))[0];
    const invoice = makeInvoice(job.id, 100000);
    await invoiceRepo.create(invoice);

    // Add an unrelated payment via a different providerReference; it
    // should NOT count toward depositCreditCents.
    const cashPayment: Payment = {
      id: uuidv4(),
      tenantId: TENANT,
      invoiceId: invoice.id,
      amountCents: 30000,
      method: 'cash',
      status: 'completed',
      providerReference: 'register',
      receivedAt: new Date(),
      processedBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await paymentRepo.create(cashPayment);

    const view = await service.getByToken(VIEW_TOKEN);
    expect(view.depositCreditCents).toBe(0);
  });

  it('reads 0 when no paymentRepo dep is wired (legacy harness path)', async () => {
    const job = (await jobRepo.findByTenant(TENANT))[0];
    const invoice = makeInvoice(job.id, 100000);
    await invoiceRepo.create(invoice);
    await applyDepositCreditToInvoice(invoice, job, invoiceRepo, paymentRepo, jobRepo);

    const legacyService = new PublicInvoiceService({
      invoiceRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      // paymentRepo intentionally omitted.
    });
    const view = await legacyService.getByToken(VIEW_TOKEN);
    expect(view.depositCreditCents).toBe(0);
  });
});
