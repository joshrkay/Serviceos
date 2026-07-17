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
import { approveProposal } from '../../../src/proposals/actions';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';

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
    // PR review finding (2026-07): a free-text estimateReference with no
    // estimateRepo wired now gates missingFields — this proposal used to
    // be silently approvable and then fail at execution (doomed-approval
    // → gated is strictly safer; see the "estimateId resolution" describe
    // block below).
    expect(result.proposal.sourceContext).toEqual({
      conversationId: 'conv-7',
      missingFields: ['estimateId'],
    });
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

  // PR review finding (2026-07): UpdateEstimateExecutionHandler
  // (proposals/execution/update-estimate-handler.ts) strictly requires
  // payload.estimateId to already be a string id and has no reference
  // resolution of its own. Previously this handler never gated
  // missingFields on a free-text estimateReference, so "add a trip fee to
  // the Johnson estimate" was approvable straight from drafting and
  // execution then failed on the unresolved reference. Mirrors the
  // update_invoice fix (InvoiceEditTaskHandler.resolveInvoiceId in
  // invoice-edit-task.ts): reference resolution now runs at drafting time
  // via resolveEstimateIdGate (which reuses resolveTargetEstimate's
  // search — the same one that powers the RV-042 marker above) and an
  // unresolved reference gates the proposal.
  describe('estimateId resolution / missingFields gating', () => {
    function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
      const lineItems: LineItem[] = [
        buildLineItem('li-1', 'Service call', 1, 12500, 0, true, 'labor'),
      ];
      return {
        id: 'est-1',
        tenantId,
        jobId: 'job-1',
        estimateNumber: 'EST-0001',
        status: 'draft',
        lineItems,
        totals: calculateDocumentTotals(lineItems, 0, 0),
        version: 1,
        createdBy: userId,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
        ...overrides,
      };
    }

    function editGateway(estimateReference = 'EST-0001'): LLMGateway {
      return mockGateway(
        JSON.stringify({
          estimateReference,
          editActions: [
            { type: 'add_line_item', lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 } },
          ],
          confidence_score: 0.9,
        }),
      );
    }

    it('an unresolvable free-text reference (no estimateRepo wired) gates missingFields and blocks approval', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const handler = new EstimateEditTaskHandler(editGateway());
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to the Johnson estimate',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.estimateId).toBeUndefined();
      expect(payload.estimateReference).toBe('EST-0001');
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['estimateId'] });

      await proposalRepo.create(result.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, result.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    it('a reference that resolves to exactly one estimate via estimateRepo search is stamped onto payload.estimateId, but STAYS gated', async () => {
      // See resolveEstimateIdGate's doc comment in estimate-edit-task.ts:
      // a search-resolved id is deliberately still gated because
      // assistant.ts's dropUnverifiedIds strips any id-shaped payload
      // field that isn't literally present in the operator's raw text —
      // a DB-resolved id from a free-text search never is. Only a
      // reference that is already a literal UUID is trusted to bypass
      // review (next test).
      const estimateRepo = new InMemoryEstimateRepository();
      const estimate = await estimateRepo.create(makeEstimate());

      const proposalRepo = new InMemoryProposalRepository();
      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.estimateId).toBe(estimate.id);
      expect(payload.estimateReference).toBe('EST-0001');
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['estimateId'] });

      await proposalRepo.create(result.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, result.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    it('an ambiguous reference (>1 match via estimateRepo search) gates missingFields and does not set estimateId', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      // Same estimate number on two rows is the simplest way to force >1
      // search hits for this in-memory repo's ILIKE-style match.
      await estimateRepo.create(makeEstimate({ id: 'est-1', estimateNumber: 'EST-0001' }));
      await estimateRepo.create(makeEstimate({ id: 'est-2', estimateNumber: 'EST-0001' }));

      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.estimateId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['estimateId'] });
    });

    it('an already-UUID reference lands directly on payload.estimateId with no gate', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const uuidRef = '00000000-0000-4000-8000-000000000001';
      const handler = new EstimateEditTaskHandler(editGateway(uuidRef));
      const result = await handler.handle({
        tenantId,
        userId,
        message: `Add a trip fee to estimate ${uuidRef}`,
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.estimateId).toBe(uuidRef);
      expect(result.proposal.sourceContext ?? {}).not.toHaveProperty('missingFields');

      // Approval is not blocked by a missing estimateId (may still be
      // gated by other rules, e.g. uncatalogued pricing — not the concern
      // of this test); the key assertion is missingFields is absent.
      await proposalRepo.create(result.proposal);
    });

    it('a reference that matches zero estimates gates missingFields and does not set estimateId', async () => {
      const estimateRepo = new InMemoryEstimateRepository();
      // Repo has estimates, but none matching "EST-0001".
      await estimateRepo.create(makeEstimate({ id: 'est-9', estimateNumber: 'EST-9999' }));

      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.estimateId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['estimateId'] });
    });

    it('the RV-042 acceptance-void marker still fires alongside the new estimateId gating', async () => {
      // Proves the two behaviors compose: an accepted estimate resolved via
      // free-text search gets BOTH the acceptance-void marker (RV-042,
      // review-time visibility) AND missingFields: ['estimateId'] (this
      // fix, approval gating) — neither suppresses the other.
      const estimateRepo = new InMemoryEstimateRepository();
      await estimateRepo.create(
        makeEstimate({ status: 'accepted', acceptedAt: new Date('2026-06-05T12:00:00Z') }),
      );

      const handler = new EstimateEditTaskHandler(editGateway(), estimateRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Add a trip fee to EST-0001',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.estimateId).toBe('est-1');
      const meta = payload._meta as { markers?: Array<{ path: string; reason: string }> } | undefined;
      expect(meta?.markers).toContainEqual(ACCEPTANCE_VOID_MARKER);
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['estimateId'] });
    });
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
      estimateReference = 'EST-0001',
    ): LLMGateway {
      return mockGateway(
        JSON.stringify({
          estimateReference,
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

    it('(a) a catalogued edit line takes the catalog price (both price fields), snapping a sub-tolerance mishear, and auto-approves', async () => {
      const repo = new InMemoryCatalogItemRepository();
      const [siteVisit] = await seedCatalog(repo, [{ name: 'Site Visit', unitPriceCents: 15000 }]);

      const gateway = editResponse(
        // 15050 is within 100¢ of the catalog's 15000 → snap, not a conflict.
        { description: 'site visit', quantity: 1, unitPrice: 15050 },
        0.9,
        // PR review finding (2026-07): a free-text estimateReference
        // ("EST-0001") now gates missingFields: ['estimateId'] regardless
        // of confidence (UpdateEstimateExecutionHandler has no reference
        // resolution of its own — see resolveEstimateIdGate in
        // estimate-edit-task.ts). This test's purpose is catalog-pricing
        // auto-approval behavior, not estimateId resolution, so it uses an
        // already-resolved UUID reference — exactly what
        // resolveEstimateIdGate treats as "already a resolved id" — to
        // keep the estimateId gate out of the picture.
        '00000000-0000-4000-8000-000000000001',
      );
      const handler = new EstimateEditTaskHandler(gateway, undefined, repo);
      const result = await handler.handle({ tenantId, userId, message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      // Estimate edits execute against `unitPrice`; `unitPriceCents` mirrors.
      expect(lineItem.unitPrice).toBe(15000); // catalog snaps the LLM's 15050
      expect(lineItem.unitPriceCents).toBe(15000);
      expect(lineItem.catalogItemId).toBe(siteVisit.id);
      expect(lineItem.pricingSource).toBe('catalog');
      expect(result.proposal.confidenceScore).toBe(0.9); // not force-capped
      expect(payload._meta?.overallConfidence).not.toBe('low');
      expect(result.proposal.status).toBe('approved');
    });

    it('(a2) surfaces a price conflict (large deviation) instead of silently snapping — keeps spoken price, flags for review', async () => {
      const repo = new InMemoryCatalogItemRepository();
      await seedCatalog(repo, [{ name: 'Site Visit', unitPriceCents: 15000 }]);

      const gateway = editResponse(
        // Deviates from the catalog's 15000 by ≥10% AND ≥$1 — a deliberate
        // custom price ("half price for Mrs. Henderson"), not a mishear.
        { description: 'site visit', quantity: 1, unitPrice: 7500 },
        0.98,
      );
      const handler = new EstimateEditTaskHandler(gateway, undefined, repo);
      const result = await handler.handle({ tenantId, userId, message: 'edit', ...supervised });

      const payload = result.proposal.payload as {
        editActions: Array<Record<string, unknown>>;
        _meta?: { overallConfidence?: string };
      };
      const lineItem = payload.editActions[0].lineItem as Record<string, unknown>;
      expect(lineItem.unitPrice).toBe(7500); // spoken price KEPT, not snapped
      expect(lineItem.unitPriceCents).toBeNull();
      expect(lineItem.pricingSource).toBe('ambiguous');
      expect(lineItem.needsPricing).toBe(true);
      expect(lineItem.catalogItemId).toBeUndefined();
      expect(payload._meta?.overallConfidence).toBe('low');
      expect(result.proposal.confidenceScore).toBeLessThanOrEqual(UNCATALOGUED_CONFIDENCE_CAP);
      expect(result.proposal.status).not.toBe('approved');
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
