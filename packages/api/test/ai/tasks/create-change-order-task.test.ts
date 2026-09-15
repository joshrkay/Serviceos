/**
 * Tradesperson wave 1, Task 6 — CreateChangeOrderTaskHandler (drafting leg).
 *
 * `create_change_order` joins `JOB_REF_INTENTS` (entity-resolution.ts), so
 * the voice-action-router resolves the spoken jobReference to a verified
 * `jobId` BEFORE this handler runs and stamps it onto
 * `context.existingEntities.jobId` — the generic resolution behavior itself
 * is pinned in test/ai/agents/customer-calling/entity-resolution.test.ts.
 * These tests cover what THIS handler does with an already-resolved (or
 * unresolved) `jobId`, the single-line-item shape it builds from the
 * spoken work description + amount, catalog-price grounding, and the
 * mandatory `_meta`/`assertValidProposalPayload` contract gate.
 */
import { describe, it, expect } from 'vitest';
import { CreateChangeOrderTaskHandler } from '../../../src/ai/tasks/create-change-order-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';
import { validateProposalPayload } from '../../../src/proposals/contracts';
import { createCatalogItem, InMemoryCatalogItemRepository } from '../../../src/catalog/catalog-item';

const TENANT_ID = 't-1';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'the Garcias want a second zone, change order for 1800',
    ...overrides,
  };
}

async function catalogWith(items: Array<{ name: string; unitPriceCents: number }>) {
  const repo = new InMemoryCatalogItemRepository();
  for (const it of items) {
    await repo.create(
      createCatalogItem({
        tenantId: TENANT_ID,
        name: it.name,
        category: 'Labor',
        unit: 'each',
        unitPriceCents: it.unitPriceCents,
      }),
    );
  }
  return repo;
}

describe('CreateChangeOrderTaskHandler', () => {
  it('a resolved jobId + work description + amount drafts ungated', async () => {
    const { proposal, taskType } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: 180000 } }),
    );

    expect(taskType).toBe('create_change_order');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('capture');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBe(JOB_ID);
    expect(missingFieldsFor(proposal)).toEqual([]);
    // Quality-review fix — the drafted payload must always satisfy its own
    // Zod contract (assertValidProposalPayload gate inside handle()); this
    // is the SAME assertion editProposal/approveProposal make at the
    // review-card choke point, so a failure here means the proposal would
    // 400 the moment an operator touched it.
    expect(validateProposalPayload('create_change_order', payload).valid).toBe(true);
  });

  // The whole point of this type: a change order without its job is
  // meaningless, so an unresolved reference must gate — flat key, no repo
  // required at drafting time (resolution already happened upstream).
  it('an unresolved reference (no jobId stamped by the router) gates with a FLAT jobId key', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { changeOrderDescription: 'Second zone', amount: 180000 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('jobId');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a raw free-text jobReference alone (never resolved) does NOT satisfy jobId', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Garcia job', changeOrderDescription: 'Second zone', amount: 180000 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('jobId');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.jobId).toBeUndefined();
  });

  it('the work description becomes the change order title, prefixed', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Add second zone', amount: 180000 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.title).toBe('Change order — Add second zone');
  });

  it('falls back to a bare "Change order" title when no description was spoken', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, amount: 180000 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.title).toBe('Change order');
  });

  it('the work description becomes a single line item, and the spoken amount becomes unitPriceCents', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: 180000 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].description).toBe('Second zone');
    expect(lineItems[0].quantity).toBe(1);
    expect(lineItems[0].unitPriceCents).toBe(180000);
  });

  it('rounds a fractional spoken amount to the nearest cent', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: 4599.6 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].unitPriceCents).toBe(4600);
  });

  // Quality-review fix — an unpriced line (no valid spoken amount, no
  // catalog match) used to draft UNGATED and fail post-approval at
  // execution (normalizeDraftLineItems refuses a priceless line).
  it('a zero or negative spoken amount is not trusted as a real price and GATES on lineItems[0].unitPriceCents', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: -500 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].unitPriceCents).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('lineItems[0].unitPriceCents');
  });

  // The classifier's own canonical example for this intent
  // (intent-classifier.ts taxonomy prompt: "Customer added three more
  // outlets — write it up") has NO stated amount at all — not just a
  // rejected zero/negative one. Must gate the same way.
  it('no spoken amount at all and no catalog match GATES on lineItems[0].unitPriceCents', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Three more outlets' } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].unitPriceCents).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('lineItems[0].unitPriceCents');
  });

  it('no work description at all still drafts a generic single line item (never zero line items)', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, amount: 180000 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems).toHaveLength(1);
    expect(typeof lineItems[0].description).toBe('string');
    expect((lineItems[0].description as string).length).toBeGreaterThan(0);
  });

  describe('_meta / payload-contract gate', () => {
    // Quality-review CRITICAL fix — payload._meta.overallConfidence is a
    // REQUIRED field on the shared _meta envelope (contracts.ts) whenever
    // _meta is present. Omitting it (the original bug) made every
    // uncatalogued change order (the common case — any tenant whose
    // catalog doesn't match) fail assertValidProposalPayload the moment an
    // operator tried to edit or approve it from the review card.
    it('overallConfidence is "high" for a clean catalog-priced line, "low" for an uncatalogued one — and the drafted payload always validates', async () => {
      const catalogRepo = await catalogWith([{ name: 'Second zone install', unitPriceCents: 175000 }]);
      const grounded = await new CreateChangeOrderTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone install', amount: 180000 } }),
      );
      const groundedPayload = grounded.proposal.payload as Record<string, unknown>;
      expect((groundedPayload._meta as Record<string, unknown>).overallConfidence).toBe('high');
      expect(validateProposalPayload('create_change_order', groundedPayload).valid).toBe(true);

      const uncatalogued = await new CreateChangeOrderTaskHandler().handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: 180000 } }),
      );
      const uncataloguedPayload = uncatalogued.proposal.payload as Record<string, unknown>;
      expect((uncataloguedPayload._meta as Record<string, unknown>).overallConfidence).toBe('low');
      // This is the exact assertion that would have caught the original
      // bug: no test ran the drafted (uncatalogued) payload through the
      // real Zod contract before this fix.
      expect(validateProposalPayload('create_change_order', uncataloguedPayload).valid).toBe(true);
    });

    // Proves the assertValidProposalPayload backstop actually functions
    // (not just that it's dormant on the happy path): a malformed
    // upstream jobId — e.g. a resolver/router regression that stamps a
    // non-UUID value — fails the Zod contract's `z.string().uuid()`, and
    // the gate must catch it rather than shipping an invalid payload.
    it('a payload-contract violation (malformed jobId) is caught by the gate — recorded in sourceContext and gated, never thrown', async () => {
      const { proposal } = await new CreateChangeOrderTaskHandler().handle(
        ctx({ existingEntities: { jobId: 'not-a-uuid', changeOrderDescription: 'Second zone', amount: 180000 } }),
      );

      expect(proposal.sourceContext?.payloadContractErrors).toBeDefined();
      expect(
        (proposal.sourceContext!.payloadContractErrors as string[]).some((e) => e.includes('jobId')),
      ).toBe(true);
      expect(missingFieldsFor(proposal)).toContain('jobId');
    });
  });

  describe('catalog grounding', () => {
    it('a catalog match overrides the spoken price and stamps pricingSource: catalog', async () => {
      const catalogRepo = await catalogWith([{ name: 'Second zone install', unitPriceCents: 175000 }]);
      const handler = new CreateChangeOrderTaskHandler(catalogRepo);

      const { proposal } = await handler.handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone install', amount: 180000 } }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      const lineItems = payload.lineItems as Array<Record<string, unknown>>;
      expect(lineItems[0].pricingSource).toBe('catalog');
      expect(lineItems[0].unitPriceCents).toBe(175000);
      // A grounded catalog price never gates the proposal.
      expect(missingFieldsFor(proposal)).toEqual([]);
    });

    // A catalog match FILLS IN a price even when the operator never spoke
    // one at all — grounding isn't just a price override, it's how an
    // amount-free "write it up" request can still draft priced+ungated.
    it('a catalog match fills in a price the operator never spoke', async () => {
      const catalogRepo = await catalogWith([{ name: 'Three more outlets', unitPriceCents: 45000 }]);
      const handler = new CreateChangeOrderTaskHandler(catalogRepo);

      const { proposal } = await handler.handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Three more outlets' } }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      const lineItems = payload.lineItems as Array<Record<string, unknown>>;
      expect(lineItems[0].pricingSource).toBe('catalog');
      expect(lineItems[0].unitPriceCents).toBe(45000);
      expect(missingFieldsFor(proposal)).toEqual([]);
    });

    it('an uncatalogued line rides the spoken amount as-is and is flagged uncatalogued (no catalog wired)', async () => {
      const { proposal } = await new CreateChangeOrderTaskHandler().handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: 180000 } }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      const lineItems = payload.lineItems as Array<Record<string, unknown>>;
      expect(lineItems[0].pricingSource).toBe('uncatalogued');
      expect(lineItems[0].unitPriceCents).toBe(180000);
      // Uncatalogued rides through un-gated (a human still reviews via the
      // low-confidence _meta marker below) — it never blocks the draft.
      expect(missingFieldsFor(proposal)).toEqual([]);
      const meta = payload._meta as Record<string, unknown> | undefined;
      expect(meta?.fieldConfidence).toMatchObject({ 'lineItems[0].unitPriceCents': 'low' });
    });

    // Converted from a near-duplicate "no catalog repo at all" case
    // (quality-review cleanup): a WIRED catalog that simply has no match
    // for the described work is a materially different — and more common
    // — scenario than no catalog being consulted at all, and both must
    // land on the same 'uncatalogued' pricingSource.
    it('a wired catalog with no matching item still flags the line uncatalogued', async () => {
      const catalogRepo = await catalogWith([{ name: 'Water heater flush', unitPriceCents: 12000 }]);
      const { proposal } = await new CreateChangeOrderTaskHandler(catalogRepo).handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Some rare thing', amount: 5000 } }),
      );
      const payload = proposal.payload as Record<string, unknown>;
      const lineItems = payload.lineItems as Array<Record<string, unknown>>;
      expect(lineItems[0].pricingSource).toBe('uncatalogued');
      expect(lineItems[0].unitPriceCents).toBe(5000);
    });

    // The price-CONFLICT path: an unambiguous exact/high catalog match
    // whose price is FAR from the spoken amount surfaces as a one-tap
    // ambiguity (catalog price vs. "keep the spoken price") rather than
    // silently overwriting or silently keeping — this is a materially
    // different branch than the "two candidates" ambiguous case, and the
    // exact branch that a missing _meta.overallConfidence (Bug 8) also broke.
    it('a spoken price far from an unambiguous catalog match surfaces as pricingSource: ambiguous, gated on catalogItemId', async () => {
      const catalogRepo = await catalogWith([{ name: 'Second zone install', unitPriceCents: 175000 }]);
      const { proposal } = await new CreateChangeOrderTaskHandler(catalogRepo).handle(
        // 20000 vs. the catalog's 175000 — both the $1+ absolute threshold
        // and the 10% relative threshold (PRICE_CONFLICT_MIN_ABS_CENTS /
        // PRICE_CONFLICT_MIN_REL, catalog-resolver.ts) are cleared.
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone install', amount: 20000 } }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      const lineItems = payload.lineItems as Array<Record<string, unknown>>;
      expect(lineItems[0].pricingSource).toBe('ambiguous');
      // The spoken price is kept as-is — never silently snapped to catalog.
      expect(lineItems[0].unitPriceCents).toBe(20000);
      expect(missingFieldsFor(proposal)).toContain('lineItems[0].catalogItemId');
      // Ambiguous-only (not uncatalogued): overallConfidence stays 'high' —
      // the structural gate is missingFields, which one-tap resolution
      // clears; a persisted 'low' would never lift (mirrors
      // mms-estimate-task.test.ts's identical assertion for this branch).
      const meta = payload._meta as Record<string, unknown>;
      expect(meta.overallConfidence).toBe('high');
      expect(validateProposalPayload('create_change_order', payload).valid).toBe(true);
    });
  });
});
