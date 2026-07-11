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
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../../src/catalog/catalog-item';
import { UNCATALOGUED_CONFIDENCE_CAP } from '../../../src/ai/resolution/catalog-resolver';

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

    // The `editGateway()` transcript adds an uncatalogued "Trip fee" with no
    // catalog wired, so `_meta` is now present (VOX-50 low-confidence marker).
    // These cases assert the ACCEPTANCE-void marker specifically is ABSENT.
    function acceptanceMarkerPresent(payload: Record<string, unknown>): boolean {
      const meta = payload._meta as { markers?: Array<{ path: string; reason: string }> } | undefined;
      return Boolean(meta?.markers?.some((m) => m.path === ACCEPTANCE_VOID_MARKER.path));
    }

    it('omits the acceptance marker when the target estimate is NOT accepted', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate({ status: 'draft', acceptedAt: undefined }));

      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      expect(acceptanceMarkerPresent(result.proposal.payload as Record<string, unknown>)).toBe(false);
    });

    it('omits the acceptance marker when no estimate repo is wired', async () => {
      const handler = new EstimateEditTaskHandler(editGateway());
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });
      expect(acceptanceMarkerPresent(result.proposal.payload as Record<string, unknown>)).toBe(false);
    });

    it('omits the acceptance marker when the reference is ambiguous (two matches)', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(makeEstimate({ id: 'est-1', estimateNumber: 'EST-0001' }));
      await estimateRepo.create(makeEstimate({ id: 'est-2', estimateNumber: 'EST-00012' }));

      const handler = new EstimateEditTaskHandler(editGateway('EST-0001'), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });
      expect(acceptanceMarkerPresent(result.proposal.payload as Record<string, unknown>)).toBe(false);
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
      expect(acceptanceMarkerPresent(result.proposal.payload as Record<string, unknown>)).toBe(false);
    });
  });

  describe('VOX-50 — catalog grounding for update_estimate edits', () => {
    async function seedCatalog(
      repo: InMemoryCatalogItemRepository,
      entries: Array<{ name: string; unitPriceCents: number }>,
    ) {
      const created = [];
      for (const e of entries) {
        created.push(
          await repo.create(
            createCatalogItem({
              tenantId,
              name: e.name,
              category: 'Parts',
              unit: 'each',
              unitPriceCents: e.unitPriceCents,
            }),
          ),
        );
      }
      return created;
    }

    function editResponse(
      lineItem: Record<string, unknown>,
      confidence = 0.9,
    ): LLMGateway {
      return mockGateway(
        JSON.stringify({
          estimateReference: 'EST-0001',
          editActions: [{ type: 'add_line_item', lineItem }],
          confidence_score: confidence,
        }),
      );
    }

    // Supervisor present + low tenant threshold so ONLY the low-confidence
    // marker (not a missing supervisor) can block the uncatalogued case.
    const supervised = {
      supervisorPresent: true,
      supervisorMode: 'supervisor' as const,
      tenantThresholdOverride: { supervisor: 0.5 },
    };

    it('(a) a catalogued edit line takes the catalog price, overwriting the LLM guess, and auto-approves', async () => {
      const repo = new InMemoryCatalogItemRepository();
      const [siteVisit] = await seedCatalog(repo, [{ name: 'Site Visit', unitPriceCents: 15000 }]);

      const gateway = editResponse(
        { description: 'site visit', quantity: 1, unitPrice: 99999 },
        0.9,
      );
      const handler = new EstimateEditTaskHandler(gateway, undefined, repo);
      const result = await handler.handle({ tenantId, userId, message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.unitPrice).toBe(15000); // catalog overwrites the LLM's 99999
      expect(lineItem.unitPriceCents).toBe(15000);
      expect(lineItem.catalogItemId).toBe(siteVisit.id);
      expect(lineItem.pricingSource).toBe('catalog');
      expect(result.proposal.confidenceScore).toBe(0.9); // not force-capped
      expect(payload._meta?.overallConfidence).not.toBe('low');
      expect(result.proposal.status).toBe('approved');
    });

    it('(b) an uncatalogued edit line with LLM confidence 0.98 carries _meta.overallConfidence low and does NOT auto-approve', async () => {
      const repo = new InMemoryCatalogItemRepository();
      await seedCatalog(repo, [{ name: 'Site Visit', unitPriceCents: 15000 }]);

      const gateway = editResponse(
        { description: 'premium widget', quantity: 1, unitPrice: 12345 },
        0.98,
      );
      const handler = new EstimateEditTaskHandler(gateway, undefined, repo);
      const result = await handler.handle({ tenantId, userId, message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.pricingSource).toBe('uncatalogued');
      expect(lineItem.needsPricing).toBe(true);
      expect(lineItem.unitPriceCents).toBeNull();
      expect(payload._meta?.overallConfidence).toBe('low');
      expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
      expect(result.proposal.status).not.toBe('approved');
    });

    it('merges the acceptance-void marker with the uncatalogued marker (RV-042 + VOX-50)', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      const lineItems: LineItem[] = [
        buildLineItem('li-1', 'Replace heater', 1, 120000, 0, true, 'labor'),
      ];
      await estimateRepo.create({
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
      });
      const repo = new InMemoryCatalogItemRepository(); // empty → uncatalogued

      const gateway = editResponse({ description: 'trip fee', quantity: 1, unitPrice: 7500 }, 0.9);
      const handler = new EstimateEditTaskHandler(gateway, estimateRepo, repo);
      const result = await handler.handle({ tenantId, userId, message: 'Add a trip fee to EST-0001' });

      const meta = (result.proposal.payload as Record<string, unknown>)._meta as {
        overallConfidence?: string;
        markers?: Array<{ path: string; reason: string }>;
      };
      // Both markers present; acceptance marker stays first, uncatalogued low wins.
      expect(meta.overallConfidence).toBe('low');
      expect(meta.markers).toContainEqual(ACCEPTANCE_VOID_MARKER);
      expect(meta.markers![0].path).toBe('_acceptance');
      expect(meta.markers!.some((m) => m.path.startsWith('editActions['))).toBe(true);
    });

    it('backward compatible when constructed without a catalog repo (uncatalogued, capped)', async () => {
      const gateway = editResponse({ description: 'trip fee', quantity: 1, unitPrice: 7500 }, 0.98);
      const handler = new EstimateEditTaskHandler(gateway);
      const result = await handler.handle({ tenantId, userId, message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.pricingSource).toBe('uncatalogued');
      expect(lineItem.unitPrice).toBe(7500); // kept numeric for the Zod contract
      expect(payload._meta?.overallConfidence).toBe('low');
      expect(result.proposal.status).not.toBe('approved');
    });
  });
});
