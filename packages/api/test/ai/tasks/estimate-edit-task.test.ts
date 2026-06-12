/**
 * EstimateEditTaskHandler unit tests.
 *
 * AI task that takes a voice transcript describing an estimate edit
 * ("add a site visit to estimate EST-0001") and produces a proposal
 * with an editActions payload. Mirrors InvoiceEditTaskHandler.
 *
 * Estimate resolution (transcript reference → real estimate id) is
 * deferred to the operator review step. If the LLM can't extract
 * enough, confidence drops and the operator disambiguates.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  EstimateEditTaskHandler,
  ACCEPTANCE_VOID_MARKER,
} from '../../../src/ai/tasks/estimate-edit-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import {
  Estimate,
  InMemoryEstimateRepository,
} from '../../../src/estimates/estimate';
import {
  buildLineItem,
  calculateDocumentTotals,
  LineItem,
} from '../../../src/shared/billing-engine';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 100, output: 60, total: 160 },
      latencyMs: 44,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('EstimateEditTaskHandler', () => {
  const tenantId = 't-1';
  const userId = 'u-1';

  it('produces an update_estimate proposal with a single add_line_item', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Site visit', quantity: 1, unitPrice: 15000 },
          },
        ],
        confidence_score: 0.9,
      })
    );

    const handler = new EstimateEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Add a site visit for 150 dollars to estimate EST-0001',
    });

    expect(result.taskType).toBe('update_estimate');
    expect(result.proposal.proposalType).toBe('update_estimate');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.estimateReference).toBe('EST-0001');
    expect(Array.isArray(payload.editActions)).toBe(true);
    expect((payload.editActions as unknown[]).length).toBe(1);
  });

  it('produces a remove_line_item action when asked to remove', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [{ type: 'remove_line_item', description: 'disposal fee' }],
        confidence_score: 0.85,
      })
    );
    const handler = new EstimateEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Remove the disposal fee from estimate EST-0001',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    const actions = payload.editActions as Array<Record<string, unknown>>;
    expect(actions[0].type).toBe('remove_line_item');
    expect(actions[0].description).toBe('disposal fee');
  });

  it('supports chained edits', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
          },
          { type: 'remove_line_item', description: 'old heater' },
        ],
        confidence_score: 0.82,
      })
    );
    const handler = new EstimateEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Add a trip fee and remove the old heater from EST-0001',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect((payload.editActions as unknown[]).length).toBe(2);
  });

  it('falls back to empty editActions when LLM output is unparseable', async () => {
    const gateway = mockGateway('not json');
    const handler = new EstimateEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'tweak something on the estimate',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.editActions).toEqual([]);
    expect(result.proposal.confidenceScore ?? 1).toBeLessThan(0.9);
  });

  it('threads conversationId into sourceContext', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'fee', quantity: 1, unitPrice: 500 },
          },
        ],
        confidence_score: 0.9,
      })
    );
    const handler = new EstimateEditTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'add a fee',
      conversationId: 'conv-7',
    });
    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-7' });
  });

  it('sends update_estimate as the LLM task type', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        estimateReference: 'EST-0001',
        editActions: [
          {
            type: 'add_line_item',
            lineItem: { description: 'fee', quantity: 1, unitPrice: 500 },
          },
        ],
        confidence_score: 0.9,
      })
    );
    const handler = new EstimateEditTaskHandler(gateway);
    await handler.handle({ tenantId, userId, message: 'add a fee' });
    const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.taskType).toBe('update_estimate');
    expect(call.responseFormat).toBe('json');
  });

  describe('RV-042 — acceptance-void marker at proposal creation', () => {
    function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
      const lineItems: LineItem[] = [
        buildLineItem('li-1', 'Replace heater', 1, 120000, 0, true, 'labor'),
      ];
      return {
        id: 'est-1',
        tenantId,
        jobId: 'job-1',
        estimateNumber: 'EST-0001',
        status: 'accepted',
        lineItems,
        totals: calculateDocumentTotals(lineItems, 0, 0),
        acceptedAt: new Date('2026-06-05T12:00:00Z'),
        version: 2,
        createdBy: userId,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-05T12:00:00Z'),
        ...overrides,
      };
    }

    function editGateway(reference = 'EST-0001'): LLMGateway {
      return mockGateway(
        JSON.stringify({
          estimateReference: reference,
          editActions: [
            {
              type: 'add_line_item',
              lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
            },
          ],
          confidence_score: 0.9,
        }),
      );
    }

    it('stamps _meta.markers when the referenced estimate is currently ACCEPTED', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate());

      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      const meta = (result.proposal.payload as Record<string, unknown>)._meta as {
        markers?: Array<{ path: string; reason: string }>;
      };
      expect(meta).toBeDefined();
      expect(meta.markers).toContainEqual(ACCEPTANCE_VOID_MARKER);
      expect(meta.markers![0].path).toBe('_acceptance');
      expect(meta.markers![0].reason).toMatch(/voids the customer's prior acceptance/);
    });

    it('omits the marker when the target estimate is NOT accepted', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate({ status: 'draft', acceptedAt: undefined }));

      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      expect((result.proposal.payload as Record<string, unknown>)._meta).toBeUndefined();
    });

    it('omits the marker when no estimate repo is wired', async () => {
      const handler = new EstimateEditTaskHandler(editGateway());
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });
      expect((result.proposal.payload as Record<string, unknown>)._meta).toBeUndefined();
    });

    it('omits the marker when the reference is ambiguous (two matches)', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate({ id: 'est-1', estimateNumber: 'EST-0001' }));
      await estimateRepo.create(makeEstimate({ id: 'est-2', estimateNumber: 'EST-00012' }));

      const handler = new EstimateEditTaskHandler(editGateway('EST-0001'), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });
      expect((result.proposal.payload as Record<string, unknown>)._meta).toBeUndefined();
    });

    it('resolves by estimateId when the payload carries one', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate());

      const gateway = mockGateway(
        JSON.stringify({
          estimateId: 'est-1',
          editActions: [
            {
              type: 'add_line_item',
              lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
            },
          ],
          confidence_score: 0.9,
        }),
      );
      const handler = new EstimateEditTaskHandler(gateway, estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee',
      });
      const meta = (result.proposal.payload as Record<string, unknown>)._meta as {
        markers?: Array<{ path: string; reason: string }>;
      };
      expect(meta?.markers).toContainEqual(ACCEPTANCE_VOID_MARKER);
    });

    it('a repo failure never blocks proposal creation (marker skipped)', async () => {
      const failingRepo = {
        findById: async () => {
          throw new Error('db down');
        },
        findByTenant: async () => {
          throw new Error('db down');
        },
      };
      const handler = new EstimateEditTaskHandler(editGateway(), failingRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });
      expect(result.proposal.proposalType).toBe('update_estimate');
      expect((result.proposal.payload as Record<string, unknown>)._meta).toBeUndefined();
    });
  });
});
