import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  InMemoryCatalogItemRepository,
  type CatalogItem,
} from '../../../src/catalog/catalog-item';
import { UpdateCatalogItemExecutionHandler } from '../../../src/proposals/execution/update-catalog-item-handler';
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
