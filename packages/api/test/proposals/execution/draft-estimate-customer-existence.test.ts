/**
 * QA-2026-07-27 — existence-checked customerId on draft_estimate execution.
 *
 * The voice path used to let the drafting model author `customerId` (the
 * prompt handed it a `"customerId": "<uuid>"` template). Development drafts
 * came back carrying "unknown", "<uuid>", and — twice — the RFC 4122 EXAMPLE
 * uuid 123e4567-e89b-12d3-a456-426614174000.
 *
 * That last one is the reason this suite exists. It is SYNTACTICALLY VALID:
 * `z.string().uuid()` accepts it, so schema validation alone cannot catch it,
 * and it would reach the estimate write to either violate a foreign key or
 * silently resolve to nothing. The only sufficient check is an existence
 * check against THIS tenant's customers, which is what
 * DraftEstimateExecutionHandler now performs before any write.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DraftEstimateExecutionHandler } from '../../../src/proposals/execution/handlers';
import { validateProposalPayload } from '../../../src/proposals/contracts';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TENANT = '660e8400-e29b-41d4-a716-446655440000';
const EXECUTOR = 'user-1';
const CONTEXT = { tenantId: TENANT, executedBy: EXECUTOR };

/** RFC 4122 §C.1 example uuid — well-formed, references nothing. */
const RFC_EXAMPLE_UUID = '123e4567-e89b-12d3-a456-426614174000';

const LINE_ITEMS = [{ description: 'Pipe repair', quantity: 1, unitPrice: 7500 }];

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    status: 'approved',
    payload,
    summary: 'draft estimate',
    createdBy: EXECUTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('DraftEstimateExecutionHandler — tenant-scoped customer existence check', () => {
  let customerRepo: InMemoryCustomerRepository;
  let locationRepo: InMemoryLocationRepository;
  let jobRepo: InMemoryJobRepository;
  let handler: DraftEstimateExecutionHandler;
  let realCustomerId: string;

  beforeEach(async () => {
    customerRepo = new InMemoryCustomerRepository();
    locationRepo = new InMemoryLocationRepository();
    jobRepo = new InMemoryJobRepository();

    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Acme', lastName: 'Corp', createdBy: EXECUTOR },
      customerRepo,
    );
    realCustomerId = customer.id;
    await createLocation(
      {
        tenantId: TENANT,
        customerId: realCustomerId,
        street1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        isPrimary: true,
      },
      locationRepo,
    );

    handler = new DraftEstimateExecutionHandler(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
      jobRepo,
      locationRepo,
      new InMemoryAuditRepository(),
      customerRepo,
    );
  });

  it('the RFC example uuid passes format validation — proving format alone is insufficient', () => {
    const result = validateProposalPayload('draft_estimate', {
      customerId: RFC_EXAMPLE_UUID,
      lineItems: LINE_ITEMS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects the RFC example uuid at execution because no such customer exists', async () => {
    const result = await handler.execute(
      makeProposal({ customerId: RFC_EXAMPLE_UUID, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(RFC_EXAMPLE_UUID);
    expect(result.error).toMatch(/does not exist in this tenant/i);
    // Nothing was written on the way to the rejection.
    expect(await jobRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('rejects a well-formed uuid belonging to ANOTHER tenant (lookup is tenant-scoped)', async () => {
    const foreign = await createCustomer(
      { tenantId: OTHER_TENANT, firstName: 'Other', lastName: 'Tenant', createdBy: EXECUTOR },
      customerRepo,
    );

    const result = await handler.execute(
      makeProposal({ customerId: foreign.id, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist in this tenant/i);
  });

  it('happy path — a real tenant customer executes and opens a job', async () => {
    const result = await handler.execute(
      makeProposal({ customerId: realCustomerId, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    const jobs = await jobRepo.findByTenant(TENANT);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].customerId).toBe(realCustomerId);
  });

  it('an unresolved draft carrying only customerReference is refused, not guessed at', async () => {
    const result = await handler.execute(
      makeProposal({ customerReference: 'the Henderson place', lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/customerId/i);
  });

  it('stays inert when no customerRepo is wired (existing partial fixtures unchanged)', async () => {
    const unwired = new DraftEstimateExecutionHandler(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
      jobRepo,
      locationRepo,
      new InMemoryAuditRepository(),
    );

    const result = await unwired.execute(
      makeProposal({ customerId: RFC_EXAMPLE_UUID, lineItems: LINE_ITEMS }),
      CONTEXT,
    );

    // No repo to check against, so the handler falls through to its existing
    // behavior (here: no service location for the unknown customer).
    expect(result.error).not.toMatch(/does not exist in this tenant/i);
  });
});
