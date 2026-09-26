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
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryEstimateRepository } from '../../../src/estimates/estimate';
import { buildEstimate } from '../../factories/estimate.factory';
import { buildLineItem, calculateDocumentTotals } from '../../../src/shared/billing-engine';

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
