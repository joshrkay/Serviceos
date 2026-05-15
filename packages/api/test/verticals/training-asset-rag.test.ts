import { describe, expect, it } from 'vitest';
import { buildTrainingAssetKnowledgeChunkInput } from '../../src/verticals/training-asset-rag';
import type { VerticalTrainingAsset } from '../../src/verticals/training-assets';

function activeAsset(): VerticalTrainingAsset {
  const now = new Date('2026-05-15T00:00:00Z');
  return {
    id: 'asset-1',
    tenantId: 'tenant-1',
    verticalType: 'hvac',
    assetKind: 'rag_seed',
    status: 'active',
    title: 'No heat dispatch',
    rawText: 'Sarah has no heat.',
    scrubbedText: '[CALLER_NAME] has no heat.',
    labels: { intent: 'emergency_dispatch', shouldEscalate: true },
    provenance: { source: 'tenant_admin', sourceVersion: '3' },
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('buildTrainingAssetKnowledgeChunkInput', () => {
  it('builds tenant-scoped chunks from scrubbed text only', () => {
    const chunk = buildTrainingAssetKnowledgeChunkInput({
      asset: activeAsset(),
      embedding: Array.from({ length: 1536 }, () => 0.001),
    });

    expect(chunk.tenantId).toBe('tenant-1');
    expect(chunk.scope).toBe('tenant');
    expect(chunk.sourceType).toBe('vertical_training_asset');
    expect(chunk.content).toBe('[CALLER_NAME] has no heat.');
    expect(chunk.contentScrubbed).toBe('[CALLER_NAME] has no heat.');
    expect(chunk.metadata.verticalType).toBe('hvac');
    expect(JSON.stringify(chunk)).not.toContain('Sarah');
  });

  it('refuses inactive assets', () => {
    expect(() =>
      buildTrainingAssetKnowledgeChunkInput({
        asset: { ...activeAsset(), status: 'approved' },
        embedding: Array.from({ length: 1536 }, () => 0.001),
      }),
    ).toThrow('Only active training assets can be embedded');
  });
});
