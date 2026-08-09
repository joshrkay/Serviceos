/**
 * Tradesperson wave 1, Task 2 review fixes — UpdateCatalogItemTaskHandler.
 *
 * Covers the quality-review findings: reuse of `resolveLineItemToCatalog`
 * (ai/resolution/catalog-resolver.ts) instead of a hand-rolled substring
 * matcher, flat-key `missingFields` entries (never prose — see
 * missing-fields.ts `clearSatisfiedMissingFields`, which only lifts a gate
 * on an EXACT flat-key edit), ambiguous-match candidates surfaced on
 * `sourceContext.entityCandidates`, and the rename/description honest-no-op
 * behavior (see the class doc comment in voice-extended-tasks.ts).
 */
import { describe, it, expect } from 'vitest';
import { UpdateCatalogItemTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../../src/catalog/catalog-item';
import { MAX_UNIT_PRICE_CENTS } from '../../../src/proposals/contracts/add-catalog-item';

const TENANT_ID = 't-1';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'update the catalog',
    ...overrides,
  };
}

async function seededRepo(
  items: Array<{ name: string; unitPriceCents: number }>,
): Promise<InMemoryCatalogItemRepository> {
  const repo = new InMemoryCatalogItemRepository();
  for (const item of items) {
    await repo.create(
      createCatalogItem({
        tenantId: TENANT_ID,
        name: item.name,
        category: 'Labor',
        unit: 'each',
        unitPriceCents: item.unitPriceCents,
      }),
    );
  }
  return repo;
}

describe('UpdateCatalogItemTaskHandler', () => {
  it('a unique high-tier match with a stated price resolves ungated', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC diagnostic fee', unitPriceCents: 7900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'diagnostic fee', unitPriceCents: 8900 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.catalogItemId).toBeTruthy();
    expect(payload.currentUnitPriceCents).toBe(7900);
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('an ambiguous match (prefix-shadowed sibling) gates with a FLAT catalogItemId key and surfaces candidates', async () => {
    const catalogRepo = await seededRepo([
      { name: 'AC tune-up', unitPriceCents: 8900 },
      { name: 'AC tune-up deluxe', unitPriceCents: 14900 },
    ]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 9900 } }),
    );

    // Flat key — never a prose string. clearSatisfiedMissingFields only
    // lifts a gate on an exact flat-key edit; a prose entry could never
    // clear.
    expect(missingFieldsFor(proposal)).toContain('catalogItemId');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);

    const sourceContext = proposal.sourceContext as Record<string, unknown>;
    const candidates = sourceContext.entityCandidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.label)).toEqual(
      expect.arrayContaining(['AC tune-up', 'AC tune-up deluxe']),
    );
    expect(sourceContext.entityKind).toBe('catalogItem');
    expect(sourceContext.entityReference).toBe('AC tune-up');
    expect(proposal.explanation).toMatch(/no confident single match/i);
  });

  it('zero matches gates with a FLAT catalogItemId key and no candidates', async () => {
    const catalogRepo = await seededRepo([{ name: 'Water heater install', unitPriceCents: 145000 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'flux capacitor', unitPriceCents: 500 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('catalogItemId');
    const sourceContext = proposal.sourceContext as Record<string, unknown> | undefined;
    expect(sourceContext?.entityCandidates).toBeUndefined();
    expect(proposal.explanation).toMatch(/no catalog item matches/i);
  });

  it('an absent catalogRepo gates catalogItemId (no resolution attempted)', async () => {
    const { proposal } = await new UpdateCatalogItemTaskHandler(undefined).handle(
      ctx({ existingEntities: { catalogItemReference: 'diagnostic fee', unitPriceCents: 8900 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('catalogItemId');
  });

  it('a rename-only request (no price) resolves the item, sets an honest no-op price, and never writes payload.name to the requested value', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: {
          catalogItemReference: 'AC tune-up',
          catalogItemNewName: 'AC seasonal service',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    // No price change requested ⇒ proposed === current (a real, honest
    // value — never fabricated), and the "what to change" gate does NOT
    // fire (a name change is a real spoken change, even though it can't
    // execute through this proposal type today).
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(payload.currentUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
    // The contract's `name` field is the item's CURRENT name (informational,
    // per the contract's own doc comment) — never the requested new one,
    // which cannot execute through this proposal type. It rides `explanation`
    // instead so the reviewer sees the ask without being told it applied.
    expect(payload.name).toBe('AC tune-up');
    expect(proposal.explanation).toMatch(/requested new name: "AC seasonal service"/i);
    expect(proposal.explanation).toMatch(/catalog screen/i);
  });

  it('the no-change-field gate fires (FLAT proposedUnitPriceCents key) when neither price, name, nor description was stated', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up' } }),
    );

    expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
    expect(proposal.explanation).toMatch(/no price, name, or description change was stated/i);
  });

  it('a negative unitPriceCents is not trusted as a real price change (mirrors the durationMinutes guard)', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: -500 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    // Falls back to the current price (no fabricated change) and the
    // no-change gate fires, since no OTHER change field was stated either.
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
  });

  // Quality-review fix (2026-08-09, "I4") — mirrors add_catalog_item's own
  // MAX_UNIT_PRICE_CENTS ceiling: both intents write the SAME
  // catalog_items.unit_price_cents column from the SAME spoken
  // unitPriceCents field, so a misheard "290 thousand" must gate here
  // exactly as it does on the create side.
  //
  // Follow-up fix (2026-08-09, same day) — the ceiling was REMOVED from
  // `updateCatalogItemPayloadSchema` itself (contracts/update-catalog-item.ts)
  // because `proposedUnitPriceCents` also carries never-spoken values from
  // the correction-repetition loop and this handler's own no-price-change
  // fallback, and a shared contract ceiling wrongly rejected those. That
  // makes THIS TEST (and the exactly-ceiling test below it) the sole
  // remaining enforcement proof of the misheard-figure ceiling for this
  // intent — it no longer "mirrors" add_catalog_item's contract-level test,
  // it IS the enforcement. DO NOT DELETE AS A REDUNDANT MIRROR: nothing
  // else fails if this gate silently regresses.
  it('a unitPriceCents above the sanity ceiling is not trusted as a real price change', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: MAX_UNIT_PRICE_CENTS + 1 },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    // Falls back to the current price (no fabricated change) and the
    // no-change gate fires, since no OTHER change field was stated either
    // — same collapsing behavior the negative-price test above pins.
    expect(payload.proposedUnitPriceCents).toBe(8900);
    expect(missingFieldsFor(proposal)).toContain('proposedUnitPriceCents');
  });

  it('a unitPriceCents of exactly the sanity ceiling is trusted as a real price change', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: MAX_UNIT_PRICE_CENTS },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.proposedUnitPriceCents).toBe(MAX_UNIT_PRICE_CENTS);
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
  });

  it('a fractional unitPriceCents is rounded to the nearest cent, mirroring the durationMinutes guard', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({ existingEntities: { catalogItemReference: 'AC tune-up', unitPriceCents: 45.5 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.proposedUnitPriceCents).toBe(46);
    // A real (rounded) price change was stated, so the no-change gate
    // does not fire.
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
  });

  it('a description-only request resolves the item and rides explanation, never a fabricated payload field', async () => {
    const catalogRepo = await seededRepo([{ name: 'AC tune-up', unitPriceCents: 8900 }]);
    const { proposal } = await new UpdateCatalogItemTaskHandler(catalogRepo).handle(
      ctx({
        existingEntities: {
          catalogItemReference: 'AC tune-up',
          catalogItemNewDescription: 'Full seasonal inspection and coil clean',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.description).toBeUndefined();
    expect(missingFieldsFor(proposal)).not.toContain('proposedUnitPriceCents');
    expect(proposal.explanation).toMatch(/requested new description: "full seasonal inspection and coil clean"/i);
  });
});
