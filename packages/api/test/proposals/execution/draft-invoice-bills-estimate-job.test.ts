/**
 * #1480 item 4 (AST-07) — "new customer …, then draft an estimate for her,
 * then create and send the invoice" drafts the invoice linked to the estimate
 * step (`estimateId` from the chain) and the customer step (`customerId`),
 * with no job of its own. Executing it must bill the ESTIMATE's job — the job
 * the estimate step opened for that customer — not open a second, empty job
 * for the same work.
 */
import { describe, it, expect } from 'vitest';
import { CreateInvoiceExecutionHandler } from '../../../src/proposals/execution/invoice-execution-handler';
import type { Proposal } from '../../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';
import { InMemoryJobRepository, createJob } from '../../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { buildEstimate } from '../../factories/estimate.factory';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const EXECUTOR = 'user-1';

function seededSettings(): InMemorySettingsRepository {
  const repo = new InMemorySettingsRepository();
  const seeded: TenantSettings = {
    id: 'settings-1',
    tenantId: TENANT,
    businessName: 'Test Co',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  void repo.create(seeded);
  return repo;
}

describe('CreateInvoiceExecutionHandler — an invoice drafted from an estimate bills that estimate\'s job', () => {
  it('customerId + estimateId and no jobId: the invoice lands on the estimate\'s job, and no second job is opened', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const locationRepo = new InMemoryLocationRepository();
    const jobRepo = new InMemoryJobRepository();
    const estimateRepo = new InMemoryEstimateRepository();

    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Jane', lastName: 'Smith', createdBy: EXECUTOR },
      customerRepo,
    );
    const location = await createLocation(
      { tenantId: TENANT, customerId: customer.id, street1: '1 Main St', city: 'Mesa', state: 'AZ', postalCode: '85201', isPrimary: true },
      locationRepo,
    );
    // The job the estimate step opened when it executed.
    const estimateJob = await createJob(
      { tenantId: TENANT, customerId: customer.id, locationId: location.id, summary: 'Water heater install', createdBy: EXECUTOR },
      jobRepo,
    );
    const estimate = await estimateRepo.create(buildEstimate({ tenantId: TENANT, jobId: estimateJob.id }));

    const handler = new CreateInvoiceExecutionHandler(
      invoiceRepo,
      seededSettings(),
      new InMemoryAuditRepository(),
      jobRepo,
      locationRepo,
      customerRepo,
      undefined,
      estimateRepo,
    );
    const proposal: Proposal = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
      proposalType: 'draft_invoice',
      status: 'approved',
      payload: {
        customerId: customer.id,
        estimateId: estimate.id,
        lineItems: [{ description: 'Water heater install', quantity: 1, unitPriceCents: 120_000 }],
      },
      summary: 'Invoice',
      createdBy: EXECUTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: EXECUTOR });

    expect(result.success).toBe(true);
    const invoice = await invoiceRepo.findById(TENANT, result.resultEntityId!);
    expect(invoice?.jobId).toBe(estimateJob.id);
    expect(invoice?.estimateId).toBe(estimate.id);
    expect((await jobRepo.findByCustomer(TENANT, customer.id)).map((j) => j.id)).toEqual([estimateJob.id]);
  });
});
