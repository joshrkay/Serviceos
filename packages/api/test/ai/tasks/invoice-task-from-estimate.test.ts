/**
 * #1276F (QA 2026-09-16) — "Create an invoice from the accepted estimate"
 * drafted ONE placeholder line, "Service as per accepted estimate" at $10.00,
 * uncatalogued, while the accepted estimate totalled $1,170 and REST
 * convert-to-invoice carried it correctly. The model has no access to the
 * estimate, so any line it writes for "the estimate" is invented. When the
 * draft is about an estimate the handler can read, the lines come from it.
 *
 * Seam: InvoiceTaskHandler.handle (the invoice-from-estimate task handler).
 */
import { describe, it, expect, vi } from 'vitest';
import { InvoiceTaskHandler } from '../../../src/ai/tasks/invoice-task';
import { createRedraftHandlerFactory } from '../../../src/proposals/redraft-handler-factory';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { buildEstimate } from '../../factories/estimate.factory';
import { buildJob } from '../../factories/job.factory';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { buildLineItem, calculateDocumentTotals } from '../../../src/shared/billing-engine';
import type { JobRepository } from '../../../src/jobs/job';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const JOB = '9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f';
const ESTIMATE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** What the live model returned for this request. */
const PLACEHOLDER_REPLY = JSON.stringify({
  lineItems: [{ description: 'Service as per accepted estimate', quantity: 1, unitPrice: 1000 }],
  confidence_score: 0.9,
});

function gateway(): LLMGateway {
  return {
    complete: vi.fn(
      async (): Promise<LLMResponse> => ({
        content: PLACEHOLDER_REPLY,
        model: 'test',
        provider: 'test',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      }),
    ),
  } as unknown as LLMGateway;
}

async function acceptedEstimateRepo() {
  const lineItems = [
    buildLineItem('li-1', 'Water heater install', 1, 100000, 0, true),
    buildLineItem('li-2', 'Haul-away and permit', 1, 17000, 1, false),
  ];
  const repo = new InMemoryEstimateRepository();
  await repo.create(
    buildEstimate({
      id: ESTIMATE,
      tenantId: TENANT,
      jobId: JOB,
      status: 'accepted',
      lineItems,
      totals: calculateDocumentTotals(lineItems, 0, 0),
    }),
  );
  return repo;
}

describe('#1276F — an invoice drafted from an estimate bills the estimate, not a placeholder', () => {
  it('copies the resolved estimate\'s lines instead of the model\'s placeholder', async () => {
    const handler = new InvoiceTaskHandler(gateway(), { estimateRepo: await acceptedEstimateRepo() });

    const { proposal } = await handler.handle({
      tenantId: TENANT,
      userId: 'user-1',
      message: 'Create an invoice from the accepted estimate',
      existingEntities: { customerId: CUSTOMER, estimateId: ESTIMATE },
    });

    const lines = proposal.payload.lineItems as Array<{ description: string; unitPriceCents: number; quantity: number }>;
    expect(lines.map((l) => [l.description, l.quantity, l.unitPriceCents])).toEqual([
      ['Water heater install', 1, 100000],
      ['Haul-away and permit', 1, 17000],
    ]);
    expect(proposal.payload.estimateId).toBe(ESTIMATE);
    expect(proposal.payload.jobId).toBe(JOB);
  });

  it('"from the accepted estimate" with nothing resolved bills the one accepted estimate there is', async () => {
    const repo = await acceptedEstimateRepo();
    // A non-accepted estimate is not "the accepted estimate".
    await repo.create(buildEstimate({ tenantId: TENANT, status: 'sent' }));
    const handler = new InvoiceTaskHandler(gateway(), { estimateRepo: repo });

    const { proposal } = await handler.handle({
      tenantId: TENANT,
      userId: 'user-1',
      message: 'Create an invoice from the accepted estimate',
      existingEntities: {},
    });

    const lines = proposal.payload.lineItems as Array<{ unitPriceCents: number }>;
    expect(lines.map((l) => l.unitPriceCents)).toEqual([100000, 17000]);
    expect(proposal.payload.estimateId).toBe(ESTIMATE);
  });
});

describe('#1399 N4 — an invoice drafted from an estimate takes the customer from it', () => {
  // Live: "Create an invoice from the accepted estimate EST-0003." resolved
  // the estimate and copied its lines, but the draft 400'd on approve with
  // "unfilled required fields: customerId" — the estimate names its customer
  // (through its job), so asking the operator for one is a dead end.
  it('stamps the estimate job\'s customer and does not gate on customerId', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
    const handler = new InvoiceTaskHandler(gateway(), {
      estimateRepo: await acceptedEstimateRepo(),
      jobRepo,
    });

    const { proposal } = await handler.handle({
      tenantId: TENANT,
      userId: 'user-1',
      message: 'Create an invoice from the accepted estimate EST-0003.',
      existingEntities: { estimateId: ESTIMATE },
    });

    expect(proposal.payload.customerId).toBe(CUSTOMER);
    expect(proposal.payload.customerReference).toBeUndefined();
    const ctx = (proposal.sourceContext ?? {}) as Record<string, unknown>;
    expect(ctx.missingFields ?? []).not.toContain('customerId');
  });
});

describe('#1276F — the entity-resolution re-draft also bills the estimate', () => {
  it("createRedraftHandlerFactory's draft_invoice handler copies the accepted estimate's lines", async () => {
    const factory = createRedraftHandlerFactory({
      gateway: gateway(),
      estimateRepo: await acceptedEstimateRepo(),
    });
    const handler = factory('create_invoice');

    const { proposal } = await handler!.handle({
      tenantId: TENANT,
      userId: 'user-1',
      message: 'Create an invoice from the accepted estimate',
      existingEntities: { customerId: CUSTOMER },
    });

    const lines = proposal.payload.lineItems as Array<{ description: string; unitPriceCents: number }>;
    expect(lines.map((l) => [l.description, l.unitPriceCents])).toEqual([
      ['Water heater install', 100000],
      ['Haul-away and permit', 17000],
    ]);
    expect(proposal.payload.estimateId).toBe(ESTIMATE);
  });
});

describe('#1405 — several accepted estimates: ask which, never guess', () => {
  it("gates the draft on estimateId and asks with each of the customer's accepted estimates as a candidate", async () => {
    // One accepted estimate per job (uq_estimates_accepted_per_job), so
    // "several" means several of the customer's jobs.
    const JOB_2 = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
    const OTHER_CUSTOMERS_JOB = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a';
    const repo = new InMemoryEstimateRepository();
    const firstLines = [buildLineItem('li-a', 'Water heater install', 1, 100000, 0, true)];
    const secondLines = [buildLineItem('li-b', 'Repipe kitchen', 1, 120000, 0, true)];
    await repo.create(
      buildEstimate({
        id: ESTIMATE,
        tenantId: TENANT,
        jobId: JOB,
        estimateNumber: 'EST-0001',
        status: 'accepted',
        lineItems: firstLines,
        totals: calculateDocumentTotals(firstLines, 0, 0),
      }),
    );
    const SECOND = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
    await repo.create(
      buildEstimate({
        id: SECOND,
        tenantId: TENANT,
        jobId: JOB_2,
        estimateNumber: 'EST-0002',
        status: 'accepted',
        lineItems: secondLines,
        // $1,200 − $200 discount, 8.25% on $1,000 = $82.50 → $1,082.50.
        totals: calculateDocumentTotals(secondLines, 20000, 825),
      }),
    );
    // Another customer's accepted estimate is never offered.
    await repo.create(
      buildEstimate({ tenantId: TENANT, jobId: OTHER_CUSTOMERS_JOB, estimateNumber: 'EST-0003', status: 'accepted' }),
    );
    const jobRepo = {
      findById: vi.fn(async () => null),
      findByCustomer: vi.fn(async (_t: string, customerId: string) =>
        customerId === CUSTOMER ? [{ id: JOB }, { id: JOB_2 }] : [],
      ),
    } as unknown as Pick<JobRepository, 'findById' | 'findByCustomer'>;
    const handler = new InvoiceTaskHandler(gateway(), { estimateRepo: repo, jobRepo });

    const { proposal } = await handler.handle({
      tenantId: TENANT,
      userId: 'user-1',
      message: 'Invoice the accepted estimate',
      existingEntities: { customerId: CUSTOMER },
      conversationId: 'conv-1405',
    });

    const ctx = proposal.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toContain('estimateId');
    expect(proposal.payload.estimateId).toBeUndefined();
    const pending = ctx.pendingEntityAmbiguity as {
      entityKind: string;
      refKey: string;
      candidates: Array<{ id: string; name: string; hint?: string }>;
    };
    expect(pending.entityKind).toBe('estimate');
    expect(pending.refKey).toBe('estimateId');
    expect(pending.candidates.map((c) => [c.id, c.name, c.hint]).sort()).toEqual(
      [
        [ESTIMATE, 'EST-0001', 'accepted · $1,000.00'],
        [SECOND, 'EST-0002', 'accepted · $1,082.50'],
      ].sort(),
    );
    // Never a silent guess: the draft waits for the pick.
    expect(proposal.status).toBe('draft');
  });
});
