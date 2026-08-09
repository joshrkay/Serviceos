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

  it('a price above the sanity ceiling gates', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Whole house repipe', unitPriceCents: 100_000_01 },
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

  it('never auto-approves — omits sourceTrustTier (a deterministic, non-LLM capture handler)', async () => {
    const { proposal } = await new AddCatalogItemTaskHandler().handle(
      ctx({
        existingEntities: { catalogItemNewName: 'Sump pump replacement', unitPriceCents: 120000 },
      }),
    );

    expect(proposal.status).toBe('draft');
  });
});
