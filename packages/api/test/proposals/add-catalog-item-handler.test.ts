/**
 * Task 12 (2026-08-07 tradesperson plan) — add_catalog_item proposal type +
 * execution handler.
 *
 * `add_catalog_item` is a NEW capture-class proposal type: an owner adds a
 * price-book entry by voice ("Add a catalog item: smart thermostat
 * install, 385") — no money moves, and it's reversible (the item can be
 * archived from the Catalog screen). LogExpense-family execution posture:
 * degrades to a synthetic-id passthrough without a repo, persists for real
 * when wired, audit emission is failure-soft.
 */
import { describe, it, expect } from 'vitest';
import { VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';
import { AddCatalogItemExecutionHandler } from '../../src/proposals/execution/add-catalog-item-handler';
import { MAX_UNIT_PRICE_CENTS } from '../../src/proposals/contracts/add-catalog-item';
import { InMemoryCatalogItemRepository } from '../../src/catalog/catalog-item';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Proposal } from '../../src/proposals/proposal';

const TENANT = 't-1';

function makeProposal(payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'add_catalog_item',
    status: 'approved',
    payload,
    summary: 'Add catalog item',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('add_catalog_item proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('add_catalog_item');
    expect(actionClassForProposalType('add_catalog_item')).toBe('capture');
  });

  it('accepts a well-formed payload (name + price)', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'Smart thermostat install',
      unitPriceCents: 38500,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts optional description and unit', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'Sump pump replacement',
      unitPriceCents: 120000,
      description: '1/3 HP sump pump, swap and haul away',
      unit: 'each',
    });
    expect(result.valid).toBe(true);
  });

  // 0-price legality — see contracts/add-catalog-item.ts's module doc
  // comment: a free/comp price-book line is a real, common catalog entry.
  it('accepts a price of exactly 0 — a free/comp line item is legal', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'Free estimate',
      unitPriceCents: 0,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = validateProposalPayload('add_catalog_item', { name: '', unitPriceCents: 100 });
    expect(result.valid).toBe(false);
  });

  it('rejects a whitespace-only name', () => {
    const result = validateProposalPayload('add_catalog_item', { name: '   ', unitPriceCents: 100 });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = validateProposalPayload('add_catalog_item', { unitPriceCents: 100 });
    expect(result.valid).toBe(false);
  });

  it('rejects a negative price', () => {
    const result = validateProposalPayload('add_catalog_item', { name: 'x', unitPriceCents: -1 });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-integer price', () => {
    const result = validateProposalPayload('add_catalog_item', { name: 'x', unitPriceCents: 100.5 });
    expect(result.valid).toBe(false);
  });

  // Quality-review fix (2026-08-09, "I3") — the ceiling is pinned at
  // NEITHER inclusive edge by the original suite (both prior tests only
  // exercise MAX+1): if the schema ever drifted from `.max()` to `.lt()`
  // (exclusive), both this and the rejects-above-ceiling test would still
  // pass while the boundary itself silently moved. Exactly-at-the-ceiling
  // must validate.
  it('accepts a price of exactly the sanity ceiling (100_000_00)', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'Whole house repipe',
      unitPriceCents: MAX_UNIT_PRICE_CENTS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a price one cent above the sanity ceiling', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'x',
      unitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing price', () => {
    const result = validateProposalPayload('add_catalog_item', { name: 'x' });
    expect(result.valid).toBe(false);
  });

  it('rejects a whitespace-only description', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'x',
      unitPriceCents: 100,
      description: '   ',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an out-of-vocabulary unit', () => {
    const result = validateProposalPayload('add_catalog_item', {
      name: 'x',
      unitPriceCents: 100,
      unit: 'per widget',
    });
    expect(result.valid).toBe(false);
  });
});

describe('AddCatalogItemExecutionHandler', () => {
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };
  const goodPayload = { name: 'Smart thermostat install', unitPriceCents: 38500 };

  it('degrades to a synthetic-id passthrough when no repo is wired', async () => {
    const handler = new AddCatalogItemExecutionHandler();
    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('isFullyWired requires the catalog repo', () => {
    expect(new AddCatalogItemExecutionHandler(new InMemoryCatalogItemRepository()).isFullyWired()).toBe(true);
    expect(new AddCatalogItemExecutionHandler().isFullyWired()).toBe(false);
  });

  it('persists a catalog_items row (read back via the repo) + emits a failure-soft audit event when wired', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo, auditRepo);

    const result = await handler.execute(makeProposal(goodPayload), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    // Assert by reading back through the repo, not the result object.
    const created = await catalogRepo.findById(TENANT, result.resultEntityId!);
    expect(created).not.toBeNull();
    expect(created!.name).toBe('Smart thermostat install');
    expect(created!.unitPriceCents).toBe(38500);
    expect(created!.category).toBe('Labor');
    expect(created!.unit).toBe('each');

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('catalog_item.created');
    expect(events[0].entityId).toBe(result.resultEntityId);
    // Spec-review addendum — the analytics claim (audit-event-mapping.ts
    // maps catalog_item.created's category/unit/unitPriceCents/hasImage
    // to pickMeta) rests on these four metadata props actually reaching
    // the event; mirrors create-service-agreement-handler.test.ts's
    // toMatchObject assertion for the identical reason. `name` IS in
    // metadata (parity with persistCatalogItem's own shape, for anyone
    // reading the audit trail) but the mapping deliberately does NOT pick
    // it — no business label reaches analytics, same as the HTTP path —
    // so it's asserted present here without asserting the mapping reads it.
    expect(events[0].metadata).toMatchObject({
      proposalId: 'prop-1',
      proposalType: 'add_catalog_item',
      name: 'Smart thermostat install',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: 38500,
      hasImage: false,
    });
  });

  it('defaults unit to "each" when the payload omits it', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo);
    const result = await handler.execute(makeProposal(goodPayload), ctx);
    const created = await catalogRepo.findById(TENANT, result.resultEntityId!);
    expect(created!.unit).toBe('each');
  });

  it('carries a spoken unit through to the persisted row', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo);
    const result = await handler.execute(
      makeProposal({ name: 'Copper pipe', unitPriceCents: 500, unit: 'per lb' }),
      ctx,
    );
    const created = await catalogRepo.findById(TENANT, result.resultEntityId!);
    expect(created!.unit).toBe('per lb');
  });

  it('carries a spoken description through to the persisted row', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo);
    const result = await handler.execute(
      makeProposal({
        name: 'Sump pump replacement',
        unitPriceCents: 120000,
        description: 'swap and haul away',
      }),
      ctx,
    );
    const created = await catalogRepo.findById(TENANT, result.resultEntityId!);
    expect(created!.description).toBe('swap and haul away');
  });

  it('persists a free/comp line item priced at 0', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo);
    const result = await handler.execute(makeProposal({ name: 'Free estimate', unitPriceCents: 0 }), ctx);
    expect(result.success).toBe(true);
    const created = await catalogRepo.findById(TENANT, result.resultEntityId!);
    expect(created!.unitPriceCents).toBe(0);
  });

  it('fails cleanly on an invalid payload (empty name) without throwing', async () => {
    const handler = new AddCatalogItemExecutionHandler(new InMemoryCatalogItemRepository());
    const result = await handler.execute(makeProposal({ name: '', unitPriceCents: 100 }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Could not determine the catalog item to add (missing name or an invalid price).',
    );
  });

  it('replays the same resultEntityId without creating a second row when already executed', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo);

    const already: Proposal = { ...makeProposal(goodPayload), resultEntityId: 'catalog-existing' };
    const result = await handler.execute(already, ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'catalog-existing' });
    expect(await catalogRepo.listByTenant(TENANT)).toHaveLength(0);
  });

  it('tenant isolation — a catalog item created for one tenant is invisible from another tenant', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new AddCatalogItemExecutionHandler(catalogRepo);

    const result = await handler.execute(makeProposal(goodPayload), { tenantId: 't-2', executedBy: 'u-2' });
    expect(result.success).toBe(true);
    expect(await catalogRepo.listByTenant(TENANT)).toHaveLength(0);
    expect(await catalogRepo.listByTenant('t-2')).toHaveLength(1);
  });
});
