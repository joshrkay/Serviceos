/**
 * #1499 (P3) — approving a chat-drafted estimate with no job opens one, and
 * that job was named with the proposal summary: on the chat surface, the
 * operator's raw sentence ("Draft an estimate for Intake QA49125: blower
 * motor replacement $425 and a diagnostic visit $89."). The job list then
 * read like a chat log. The job is named for the work: its line items.
 *
 * Seam: DraftEstimateExecutionHandler.execute — what an approved proposal
 * runs — observed through the job repository it writes.
 */
import { describe, it, expect } from 'vitest';
import { DraftEstimateExecutionHandler } from '../../../src/proposals/execution/handlers';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const EXECUTOR = 'user-1';
const UTTERANCE =
  'Draft an estimate for Intake QA49125: blower motor replacement $425 and a diagnostic visit $89.';

describe('draft_estimate execution — the auto-opened job is named for the work, not the chat sentence', () => {
  it('names the job from the line items', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const locationRepo = new InMemoryLocationRepository();
    const jobRepo = new InMemoryJobRepository();
    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Intake', lastName: 'QA49125', createdBy: EXECUTOR },
      customerRepo,
    );
    await createLocation(
      {
        tenantId: TENANT,
        customerId: customer.id,
        street1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        isPrimary: true,
      },
      locationRepo,
    );
    const handler = new DraftEstimateExecutionHandler(
      new InMemoryEstimateRepository(),
      new InMemorySettingsRepository(),
      jobRepo,
      locationRepo,
      new InMemoryAuditRepository(),
      customerRepo,
    );
    const proposal: Proposal = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
      proposalType: 'draft_estimate',
      status: 'approved',
      payload: {
        customerId: customer.id,
        lineItems: [
          { description: 'Blower Motor Replacement', quantity: 1, unitPrice: 42500 },
          { description: 'Diagnostic visit', quantity: 1, unitPrice: 8900 },
        ],
      },
      summary: UTTERANCE,
      createdBy: EXECUTOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: EXECUTOR });
    expect(result.success).toBe(true);
    const [job] = await jobRepo.findByTenant(TENANT);
    expect(job.summary).toBe('Blower Motor Replacement, Diagnostic visit');
  });
});
