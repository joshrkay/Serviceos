/**
 * Task 12 (2026-08-07 tradesperson plan) — AddCatalogItemTaskHandler
 * (drafting leg).
 *
 * `add_catalog_item` REUSES update_catalog_item's catalogItemNewName /
 * unitPriceCents / catalogItemNewDescription extraction fields (see the
 * handler's own doc comment for the reuse-vs-new decision) and adds one
 * genuinely new field, catalogItemUnit. Zero is a LEGAL unitPriceCents (a
 * free/comp price-book line) — this suite pins that the drafting gate
 * agrees with the contract at that exact boundary.
 */
import { describe, it, expect } from 'vitest';
import { AddCatalogItemTaskHandler } from '../../../src/ai/tasks/add-catalog-item-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';
import { MAX_UNIT_PRICE_CENTS } from '../../../src/proposals/contracts/add-catalog-item';

const TENANT_ID = 't-1';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'Add a catalog item: smart thermostat install, 385',
    ...overrides,
  };
}

describe('AddCatalogItemTaskHandler', () => {
  it('a spoken name + price drafts ungated', async () => {
    const { proposal, taskType } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Smart thermostat install', unitPriceCents: 38500 },
      }),
    );

    expect(taskType).toBe('add_catalog_item');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('capture');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.name).toBe('Smart thermostat install');
    expect(payload.unitPriceCents).toBe(38500);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('a missing name gates with a FLAT name key', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({ existingEntities: { unitPriceCents: 38500 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('name');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a whitespace-only name gates (treated as absent)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({ existingEntities: { catalogItemNewName: '   ', unitPriceCents: 38500 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('name');
  });

  it('a missing price gates with a FLAT unitPriceCents key', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({ existingEntities: { catalogItemNewName: 'Sump pump replacement' } }),
    );

    expect(missingFieldsFor(proposal)).toContain('unitPriceCents');
  });

  it('a spoken price of exactly 0 drafts ungated — a free/comp line item is legal', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({ existingEntities: { catalogItemNewName: 'Free estimate', unitPriceCents: 0 } }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.unitPriceCents).toBe(0);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('a negative price gates (never persisted)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({ existingEntities: { catalogItemNewName: 'Bad price', unitPriceCents: -100 } }),
    );

    expect(missingFieldsFor(proposal)).toContain('unitPriceCents');
  });

  // Quality-review fix (2026-08-09, "I3") — exactly-at-the-ceiling must
  // draft ungated, mirroring the contract's own inclusive `.max()`. Both
  // this and the above/below tests only exercising MAX+1 would let the
  // contract and this gate silently drift apart at the boundary itself
  // (e.g. one flipping to an exclusive `<`) with nothing to catch it.
  it('a spoken price of exactly the sanity ceiling (100_000_00) drafts ungated', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Whole house repipe', unitPriceCents: MAX_UNIT_PRICE_CENTS },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.unitPriceCents).toBe(MAX_UNIT_PRICE_CENTS);
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('a price one cent above the sanity ceiling gates', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: {
          catalogItemNewName: 'Whole house repipe',
          unitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
        },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('unitPriceCents');
  });

  it('description passes through when spoken, trimmed', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: {
          catalogItemNewName: 'Sump pump replacement',
          unitPriceCents: 120000,
          catalogItemNewDescription: '  1/3 HP sump pump, swap and haul away  ',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.description).toBe('1/3 HP sump pump, swap and haul away');
  });

  it('omits description entirely when not spoken (never fabricated)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Sump pump replacement', unitPriceCents: 120000 },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.description).toBeUndefined();
  });

  it('unit passes through when spoken', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: {
          catalogItemNewName: 'Copper pipe',
          unitPriceCents: 500,
          catalogItemUnit: 'per lb',
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.unit).toBe('per lb');
  });

  it('omits unit entirely when not spoken (execution defaults it, drafting never guesses)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Sump pump replacement', unitPriceCents: 120000 },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.unit).toBeUndefined();
  });

  // Quality-review + spec-review fix (2026-08-09) — the canonical
  // misclassification shape: "rename the diagnostic fee to Service call
  // fee, make it 89" can classify as add_catalog_item (instead of
  // update_catalog_item), with the model emitting catalogItemReference
  // (the EXISTING item) ALONGSIDE catalogItemNewName/unitPriceCents. Prior
  // to this fix, this drafted a COMPLETE, zero-missingFields NEW item —
  // approving it would create a duplicate SKU (catalog_items has no
  // unique constraint on (tenant_id, name)) instead of renaming the
  // existing one.
  it('gates when catalogItemReference is present, even with a complete name+price payload (rename+reprice misclassification)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: {
          catalogItemReference: 'the diagnostic fee',
          catalogItemNewName: 'Service call fee',
          unitPriceCents: 8900,
        },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('name');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
    // The payload never fills in — this refuses to draft a create at all,
    // not just gate one field of an otherwise-complete one.
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.name).toBeUndefined();
    expect(payload.unitPriceCents).toBeUndefined();
    expect(proposal.explanation).toMatch(/sounds like an edit/i);
    expect(proposal.explanation).toMatch(/update_catalog_item/);
  });

  it('never auto-approves — omits sourceTrustTier (a deterministic, non-LLM capture handler)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Sump pump replacement', unitPriceCents: 120000 },
      }),
    );

    expect(proposal.status).toBe('draft');
  });
});
