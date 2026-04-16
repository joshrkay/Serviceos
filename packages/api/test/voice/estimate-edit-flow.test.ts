/**
 * End-to-end integration for Phase 2b (estimate edits).
 *
 * Voice transcript → classifier → EstimateEditTaskHandler → proposal
 * persisted → UpdateEstimateExecutionHandler runs → real InMemory
 * estimate mutated.
 *
 * Only the LLM is mocked. Every other seam is production code.
 * Mirrors test/voice/invoice-edit-flow.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  InMemoryEstimateRepository,
  Estimate,
} from '../../src/estimates/estimate';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { UpdateEstimateExecutionHandler } from '../../src/proposals/execution/update-estimate-handler';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

function silentLogger(): Logger {
  const noop = () => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function routerMsg<T>(payload: T): QueueMessage<T> {
  return {
    id: 'msg-1',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

function seedEstimate(): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Site visit', 1, 15000, 0, true, 'labor'),
    buildLineItem('li-2', '50-gallon heater', 1, 85000, 1, true, 'material'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'est-1',
    tenantId: 't-1',
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'draft',
    lineItems,
    totals,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
  };
}

describe('integration — voice "add item to estimate" → proposal → executed', () => {
  it('adds a line item to the real estimate through the full chain', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    await estimateRepo.create(seedEstimate());

    const { gateway, provider } = createMockLLMGateway('{}');
    const responses = [
      JSON.stringify({
        intentType: 'update_estimate',
        confidence: 0.92,
        extractedEntities: { jobReference: 'EST-0001', lineItemDescriptions: ['disposal fee'] },
      }),
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Disposal fee', quantity: 1, unitPrice: 7500, category: 'other' },
          },
        ],
        confidence_score: 0.92,
      }),
    ];
    let call = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async () => ({
      content: responses[Math.min(call++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }));

    const router = createVoiceActionRouterWorker({ gateway, proposalRepo });
    await router.handle(
      routerMsg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Add a disposal fee for 75 to estimate EST-0001',
      } satisfies VoiceActionRouterPayload),
      silentLogger()
    );

    const proposals = await proposalRepo.findByTenant('t-1');
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal.proposalType).toBe('update_estimate');

    const classifierPayload = proposal.payload as Record<string, unknown>;
    expect(classifierPayload.estimateReference).toBe('EST-0001');

    // Review step resolves the reference to a concrete estimateId.
    const executablePayload: Record<string, unknown> = {
      estimateId: 'est-1',
      editActions: classifierPayload.editActions,
    };
    const executor = new UpdateEstimateExecutionHandler(estimateRepo);
    const result = await executor.execute(
      { ...proposal, payload: executablePayload },
      { tenantId: 't-1', executedBy: 'u-1' }
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('est-1');

    const updated = await estimateRepo.findById('t-1', 'est-1');
    expect(updated!.lineItems).toHaveLength(3);
    expect(updated!.lineItems[2].description).toBe('Disposal fee');
    expect(updated!.totals.subtotalCents).toBe(15000 + 85000 + 7500);
  });

  it('removes a line item from the real estimate', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    await estimateRepo.create(seedEstimate());

    const { gateway, provider } = createMockLLMGateway('{}');
    const responses = [
      JSON.stringify({
        intentType: 'update_estimate',
        confidence: 0.9,
        extractedEntities: { jobReference: 'EST-0001' },
      }),
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [{ type: 'remove_line_item', description: 'heater' }],
        confidence_score: 0.9,
      }),
    ];
    let call = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async () => ({
      content: responses[Math.min(call++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }));

    const router = createVoiceActionRouterWorker({ gateway, proposalRepo });
    await router.handle(
      routerMsg({
        tenantId: 't-1',
        userId: 'u-1',
        transcript: 'Remove the heater from estimate EST-0001',
      } satisfies VoiceActionRouterPayload),
      silentLogger()
    );

    const proposal = (await proposalRepo.findByTenant('t-1'))[0];
    const executor = new UpdateEstimateExecutionHandler(estimateRepo);
    const result = await executor.execute(
      {
        ...proposal,
        payload: {
          estimateId: 'est-1',
          editActions: [{ type: 'remove_line_item', index: 1 }],
        },
      },
      { tenantId: 't-1', executedBy: 'u-1' }
    );
    expect(result.success).toBe(true);

    const updated = await estimateRepo.findById('t-1', 'est-1');
    expect(updated!.lineItems).toHaveLength(1);
    expect(updated!.lineItems[0].description).toBe('Site visit');
  });
});
