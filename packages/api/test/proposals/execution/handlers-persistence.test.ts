import { describe, it, expect, beforeEach } from 'vitest';
import {
  UpdateCustomerExecutionHandler,
  CreateJobExecutionHandler,
  DraftEstimateExecutionHandler,
} from '../../../src/proposals/execution/handlers';
import { Proposal } from '../../../src/proposals/proposal';
import {
  InMemoryCustomerRepository,
  createCustomer,
} from '../../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { LineItem } from '../../../src/shared/billing-engine';
import { v4 as uuidv4 } from 'uuid';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const EXECUTOR = 'user-1';
const CONTEXT = { tenantId: TENANT, executedBy: EXECUTOR };

function makeProposal(
  proposalType: Proposal['proposalType'],
  payload: Record<string, unknown>,
  extra?: Partial<Proposal>,
): Proposal {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    proposalType,
    status: 'approved',
    payload,
    summary: 'test proposal',
    createdBy: EXECUTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

const sampleLineItems: LineItem[] = [
  {
    id: uuidv4(),
    description: 'Diagnostic',
    quantity: 1,
    unitPriceCents: 45000,
    totalCents: 45000,
    sortOrder: 0,
    taxable: true,
  },
];

describe('UpdateCustomerExecutionHandler persistence', () => {
  it('persists patched fields when customerRepo is wired', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const created = await createCustomer(
      {
        tenantId: TENANT,
        firstName: 'Jane',
        lastName: 'Doe',
        createdBy: EXECUTOR,
      },
      customerRepo,
    );

    const handler = new UpdateCustomerExecutionHandler(customerRepo);
    const result = await handler.execute(
      makeProposal('update_customer', {
        customerId: created.id,
        name: 'Jane Smith',
        email: 'jane.smith@example.com',
      }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const updated = await customerRepo.findById(TENANT, created.id);
    expect(updated?.firstName).toBe('Jane');
    expect(updated?.lastName).toBe('Smith');
    expect(updated?.email).toBe('jane.smith@example.com');
  });

  it('returns not found when customerId does not exist', async () => {
    const handler = new UpdateCustomerExecutionHandler(new InMemoryCustomerRepository());
    const result = await handler.execute(
      makeProposal('update_customer', {
        customerId: uuidv4(),
        name: 'Nobody',
      }),
      CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});

describe('CreateJobExecutionHandler persistence', () => {
  let customerRepo: InMemoryCustomerRepository;
  let locationRepo: InMemoryLocationRepository;
  let jobRepo: InMemoryJobRepository;
  let customerId: string;
  let primaryLocationId: string;

  beforeEach(async () => {
    customerRepo = new InMemoryCustomerRepository();
    locationRepo = new InMemoryLocationRepository();
    jobRepo = new InMemoryJobRepository();

    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Acme', lastName: 'Corp', createdBy: EXECUTOR },
      customerRepo,
    );
    customerId = customer.id;

    const primary = await createLocation(
      {
        tenantId: TENANT,
        customerId,
        street1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        isPrimary: true,
      },
      locationRepo,
    );
    primaryLocationId = primary.id;
  });

  it('persists a job using the customer primary location', async () => {
    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const result = await handler.execute(
      makeProposal('create_job', {
        customerId,
        title: 'Water heater replacement',
      }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const job = await jobRepo.findById(TENANT, result.resultEntityId!);
    expect(job).not.toBeNull();
    expect(job!.summary).toBe('Water heater replacement');
    expect(job!.customerId).toBe(customerId);
    expect(job!.locationId).toBe(primaryLocationId);
  });

  it('fails when the customer has no service locations', async () => {
    const loneCustomer = await createCustomer(
      { tenantId: TENANT, firstName: 'No', lastName: 'Address', createdBy: EXECUTOR },
      customerRepo,
    );

    const handler = new CreateJobExecutionHandler(jobRepo, locationRepo);
    const result = await handler.execute(
      makeProposal('create_job', {
        customerId: loneCustomer.id,
        title: 'Leak repair',
      }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no service location/i);
  });
});

describe('DraftEstimateExecutionHandler persistence', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const customerId = '22222222-2222-4222-8222-222222222222';

  it('persists an estimate when repos are wired', async () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const settingsRepo = new InMemorySettingsRepository();

    const handler = new DraftEstimateExecutionHandler(estimateRepo, settingsRepo);
    const result = await handler.execute(
      makeProposal('draft_estimate', {
        customerId,
        jobId,
        lineItems: sampleLineItems,
      }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const estimate = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(estimate).not.toBeNull();
    expect(estimate!.jobId).toBe(jobId);
    expect(estimate!.lineItems).toHaveLength(1);
    expect(estimate!.estimateNumber).toMatch(/^EST-/);
  });

  it('normalizes the estimate task shape (unitPrice, no totalCents) instead of failing', async () => {
    // Regression: the estimate task emits the contract's `unitPrice` field and
    // no `unitPriceCents`/`totalCents`. The handler used to blind-cast, so
    // totals came back NaN and the NOT NULL insert failed — every AI estimate
    // broke. sampleLineItems above hides this by pre-normalizing (the mock-
    // shape trap), so use the REAL task shape here.
    const estimateRepo = new InMemoryEstimateRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const handler = new DraftEstimateExecutionHandler(estimateRepo, settingsRepo);

    const result = await handler.execute(
      makeProposal('draft_estimate', {
        customerId,
        jobId,
        lineItems: [
          { description: 'Water heater install', quantity: 2, unitPrice: 45000, category: 'labor' },
        ],
      }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    const estimate = await estimateRepo.findById(TENANT, result.resultEntityId!);
    expect(estimate).not.toBeNull();
    const line = estimate!.lineItems[0];
    expect(line.unitPriceCents).toBe(45000);
    expect(line.totalCents).toBe(90000); // 2 × 45000, not NaN
    expect(estimate!.totals.subtotalCents).toBe(90000);
    expect(Number.isNaN(estimate!.totals.totalCents)).toBe(false);
  });

  it('rejects a line item with no price rather than persisting NaN', async () => {
    const handler = new DraftEstimateExecutionHandler(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
    );
    const result = await handler.execute(
      makeProposal('draft_estimate', {
        customerId,
        jobId,
        lineItems: [{ description: 'Mystery work', quantity: 1 }],
      }),
      CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/price/i);
  });

  it('fails when validUntil is not a parseable date', async () => {
    const handler = new DraftEstimateExecutionHandler(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
    );
    const result = await handler.execute(
      makeProposal('draft_estimate', {
        customerId,
        jobId,
        lineItems: sampleLineItems,
        validUntil: 'not-a-date',
      }),
      CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid validUntil/i);
  });

  it('fails when jobId is missing from the payload', async () => {
    const handler = new DraftEstimateExecutionHandler(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
    );
    const result = await handler.execute(
      makeProposal('draft_estimate', {
        customerId,
        lineItems: sampleLineItems,
      }),
      CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/jobId/i);
  });

  it('returns the same id on re-execution when resultEntityId is set', async () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const settingsRepo = new InMemorySettingsRepository();
    const existingId = uuidv4();

    const handler = new DraftEstimateExecutionHandler(estimateRepo, settingsRepo);
    const proposal = makeProposal(
      'draft_estimate',
      { customerId, jobId, lineItems: sampleLineItems },
      { resultEntityId: existingId },
    );

    const result = await handler.execute(proposal, CONTEXT);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(existingId);
    const all = await estimateRepo.findByJob(TENANT, jobId);
    expect(all).toHaveLength(0);
  });
});
