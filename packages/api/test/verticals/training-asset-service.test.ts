import { describe, expect, it } from 'vitest';
import { InMemoryTrainingAssetRepository } from '../../src/verticals/in-memory-training-assets';
import type { VerticalTrainingAsset } from '../../src/verticals/training-assets';

function makeAsset(overrides: Partial<VerticalTrainingAsset> = {}): VerticalTrainingAsset {
  const now = new Date('2026-05-15T00:00:00Z');
  return {
    id: 'asset-1',
    tenantId: 'tenant-1',
    verticalType: 'hvac',
    assetKind: 'rag_seed',
    status: 'active',
    title: 'No heat triage',
    rawText: 'Ask if no heat is affecting the whole home.',
    scrubbedText: 'Ask if no heat is affecting the whole home.',
    labels: { intent: 'emergency_dispatch' },
    provenance: { source: 'tenant_admin', sourceVersion: '1' },
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TrainingAssetRepository', () => {
  it('lists active assets by tenant and vertical only', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', tenantId: 'tenant-1', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-2', tenantId: 'tenant-2', verticalType: 'hvac' }));
    await repo.save(makeAsset({ id: 'asset-3', tenantId: 'tenant-1', verticalType: 'plumbing' }));
    await repo.save(makeAsset({ id: 'asset-4', tenantId: 'tenant-1', verticalType: 'hvac', status: 'draft' }));

    const active = await repo.listActiveByTenantAndVertical('tenant-1', 'hvac');

    expect(active.map((asset) => asset.id)).toEqual(['asset-1']);
  });

  it('updates lifecycle status without duplicating assets', async () => {
    const repo = new InMemoryTrainingAssetRepository();
    await repo.save(makeAsset({ id: 'asset-1', status: 'redacted' }));
    await repo.save(makeAsset({ id: 'asset-1', status: 'approved', approvedBy: 'user-2' }));

    const all = await repo.listByTenant('tenant-1');

    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('approved');
    expect(all[0].approvedBy).toBe('user-2');
  });
});
