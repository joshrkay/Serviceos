import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  InMemoryCatalogItemRepository,
  type CatalogItem,
} from '../../../src/catalog/catalog-item';
import { UpdateCatalogItemExecutionHandler } from '../../../src/proposals/execution/update-catalog-item-handler';
import { validateProposalPayload } from '../../../src/proposals/contracts';
import { MAX_UNIT_PRICE_CENTS } from '../../../src/proposals/contracts/add-catalog-item';
import type { Proposal } from '../../../src/proposals/proposal';

const TENANT = 'tenant-ws20';
const CATALOG_ID = '11111111-1111-4111-8111-111111111111';

function catalogItem(unitPriceCents: number): CatalogItem {
  return {
    id: CATALOG_ID,
    tenantId: TENANT,
    name: 'Smoke Detector',
    description: '',
    category: 'Materials',
    unit: 'each',
    productServiceType: 'product',
    archivedAt: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    unitPriceCents,
  };
}

function proposal(payload: Record<string, unknown>): Proposal {
  return {
    id: randomUUID(),
    tenantId: TENANT,
    proposalType: 'update_catalog_item',
    status: 'approved',
    payload,
    summary: 'update catalog',
    createdBy: 'ai',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Proposal;
}

// Follow-up fix (2026-08-09) — the MAX_UNIT_PRICE_CENTS ceiling on
// `proposedUnitPriceCents` was REMOVED from this contract (it briefly
// mirrored add_catalog_item's ceiling, "I4"). It was always meant as a
// backstop against a MISHEARD SPOKEN figure, but proposedUnitPriceCents
// carries never-spoken values on two producer paths: a voice name/
// description-only edit inherits the item's own untouched price
// (`requestedPriceCents ?? resolvedItem.unitPriceCents` in
// UpdateCatalogItemTaskHandler, ai/tasks/voice-extended-tasks.ts), and the
// correction-repetition loop carries `afterCents` straight from persisted
// lesson data. Both are legitimate, human-verified prices the
// misheard-figure backstop was never meant to police — a real catalog item
// priced above $100k must not be rejected on EDIT just for existing. The
// ceiling now lives ONLY in the voice drafting handler's own gate (the one
// path that ever writes a genuinely SPOKEN value into this field);
// removing it from the shared contract fixed a real regression: the
// correction loop's payload validated fine before the ceiling was added
// and then started failing `editProposal` with "Invalid payload after
// edit" for any pre-existing item priced above $100k — blaming the
// operator for a price they never touched.
//
// Producer-topology contrast with add_catalog_item (whose ceiling is
// UNCHANGED and correct, kept exactly as-is): add_catalog_item has exactly
// ONE producer (voice), so its contract-level ceiling and its drafting-time
// gate can never disagree by construction. update_catalog_item has TWO
// producers — voice AND the correction loop — and the non-voice one
// legitimately carries a human-entered/persisted price the backstop was
// never meant to police, so a SHARED contract-level ceiling was the wrong
// place to enforce it.
describe('update_catalog_item payload contract — no price ceiling (producer-topology fix)', () => {
  const basePayload = {
    catalogItemId: CATALOG_ID,
    currentUnitPriceCents: 10000,
    evidence: { lessonIds: ['l1'], correctionCount: 3 },
  };

  it('accepts a proposedUnitPriceCents of exactly the OLD sanity ceiling (100_000_00)', () => {
    const result = validateProposalPayload('update_catalog_item', {
      ...basePayload,
      proposedUnitPriceCents: MAX_UNIT_PRICE_CENTS,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a proposedUnitPriceCents one cent above the OLD sanity ceiling — the contract no longer bounds this field', () => {
    const result = validateProposalPayload('update_catalog_item', {
      ...basePayload,
      proposedUnitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a legitimately priced catalog item far above $100k (the correction-loop path)', () => {
    const result = validateProposalPayload('update_catalog_item', {
      ...basePayload,
      currentUnitPriceCents: 250_000_00,
      proposedUnitPriceCents: 250_000_00,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a proposedUnitPriceCents of exactly 0 — the nonnegative floor is inclusive', () => {
    const result = validateProposalPayload('update_catalog_item', {
      ...basePayload,
      proposedUnitPriceCents: 0,
    });
    expect(result.valid).toBe(true);
  });

  it('still rejects a negative proposedUnitPriceCents — the >= 0 floor is untouched by this fix', () => {
    const result = validateProposalPayload('update_catalog_item', {
      ...basePayload,
      proposedUnitPriceCents: -1,
    });
    expect(result.valid).toBe(false);
  });

  // currentUnitPriceCents is informational (the RESOLVED item's real,
  // already-persisted price, never spoken) and the domain/HTTP layer
  // places no upper bound on a catalog item's price — a legitimately
  // priced pre-existing item over $100k must not be rejected just for
  // being echoed back on this payload. (Unaffected by this fix — already
  // true before it — kept here for parity with proposedUnitPriceCents now
  // sharing the same "no ceiling" posture.)
  it('does NOT ceiling currentUnitPriceCents either — a pre-existing item priced above $100k still validates', () => {
    const result = validateProposalPayload('update_catalog_item', {
      ...basePayload,
      currentUnitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
      proposedUnitPriceCents: MAX_UNIT_PRICE_CENTS + 1,
    });
    expect(result.valid).toBe(true);
  });
});

describe('UpdateCatalogItemExecutionHandler', () => {
  it('applies the proposed unit price to the catalog item + emits catalog audit', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const auditRepo = new InMemoryAuditRepository();
    await catalogRepo.create(catalogItem(10000));
    const handler = new UpdateCatalogItemExecutionHandler(catalogRepo, auditRepo);

    const result = await handler.execute(
      proposal({
        catalogItemId: CATALOG_ID,
        currentUnitPriceCents: 10000,
        proposedUnitPriceCents: 8900,
        evidence: { lessonIds: ['l1'], correctionCount: 3 },
      }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(CATALOG_ID);
    const item = await catalogRepo.findById(TENANT, CATALOG_ID);
    expect(item?.unitPriceCents).toBe(8900);
    const audits = await auditRepo.findByEntity(TENANT, 'catalog_item', CATALOG_ID);
    expect(audits.some((a) => a.eventType === 'catalog_item.updated')).toBe(true);
  });

  it('fails when the catalog item does not exist', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    const handler = new UpdateCatalogItemExecutionHandler(catalogRepo);
    const result = await handler.execute(
      proposal({
        catalogItemId: CATALOG_ID,
        currentUnitPriceCents: 10000,
        proposedUnitPriceCents: 8900,
        evidence: { lessonIds: ['l1'], correctionCount: 3 },
      }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects an invalid payload (missing proposedUnitPriceCents)', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(catalogItem(10000));
    const handler = new UpdateCatalogItemExecutionHandler(catalogRepo);
    const result = await handler.execute(
      proposal({ catalogItemId: CATALOG_ID, currentUnitPriceCents: 10000 }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(false);
  });

  it('is idempotent when the proposal already carries a resultEntityId', async () => {
    const catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(catalogItem(10000));
    const handler = new UpdateCatalogItemExecutionHandler(catalogRepo);
    const p = proposal({
      catalogItemId: CATALOG_ID,
      currentUnitPriceCents: 10000,
      proposedUnitPriceCents: 8900,
      evidence: { lessonIds: ['l1'], correctionCount: 3 },
    });
    p.resultEntityId = CATALOG_ID;
    const result = await handler.execute(p, { tenantId: TENANT, executedBy: 'owner-1' });
    expect(result.success).toBe(true);
    // Untouched — the short-circuit skipped the write.
    const item = await catalogRepo.findById(TENANT, CATALOG_ID);
    expect(item?.unitPriceCents).toBe(10000);
  });

  it('reports isFullyWired() = false without a catalog repo (degraded passthrough)', async () => {
    const handler = new UpdateCatalogItemExecutionHandler();
    expect(handler.isFullyWired()).toBe(false);
    const result = await handler.execute(
      proposal({
        catalogItemId: CATALOG_ID,
        currentUnitPriceCents: 10000,
        proposedUnitPriceCents: 8900,
        evidence: { lessonIds: ['l1'], correctionCount: 3 },
      }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(true);
  });
});
