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
 * spoken work description + amount, and catalog-price grounding.
 */
import { describe, it, expect } from 'vitest';
import { CreateChangeOrderTaskHandler } from '../../../src/ai/tasks/create-change-order-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';
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

  it('a zero or negative spoken amount is not trusted as a real price (line rides with no unitPriceCents)', async () => {
    const { proposal } = await new CreateChangeOrderTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Second zone', amount: -500 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    const lineItems = payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].unitPriceCents).toBeUndefined();
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

    it('an uncatalogued line with no catalog repo wired at all is still flagged uncatalogued (no catalog consulted)', async () => {
      const { proposal } = await new CreateChangeOrderTaskHandler(undefined).handle(
        ctx({ existingEntities: { jobId: JOB_ID, changeOrderDescription: 'Some rare thing', amount: 5000 } }),
      );
      const payload = proposal.payload as Record<string, unknown>;
      const lineItems = payload.lineItems as Array<Record<string, unknown>>;
      expect(lineItems[0].pricingSource).toBe('uncatalogued');
    });
  });
});
