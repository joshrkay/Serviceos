import type { KnowledgeChunkInput } from '../ai/training/knowledge-chunks';
import { EMBEDDING_MODEL } from '../ai/training/knowledge-chunks';
import type { VerticalTrainingAsset } from './training-assets';

const MIN_POSTGRES_INTEGER = 1;
const MAX_POSTGRES_INTEGER = 2147483647;
const STRICT_NUMERIC_VERSION = /^\d+$/;

export function resolveTrainingAssetSourceVersion(asset: VerticalTrainingAsset): number {
  const sourceVersion = asset.provenance.sourceVersion;
  if (STRICT_NUMERIC_VERSION.test(sourceVersion)) {
    const parsed = Number.parseInt(sourceVersion, 10);
    if (parsed >= MIN_POSTGRES_INTEGER && parsed <= MAX_POSTGRES_INTEGER) {
      return parsed;
    }
  }

  const epochSeconds = Math.floor(asset.updatedAt.getTime() / 1000);
  return Math.max(MIN_POSTGRES_INTEGER, Math.min(MAX_POSTGRES_INTEGER, epochSeconds));
}

export function buildTrainingAssetKnowledgeChunkInput(input: {
  asset: VerticalTrainingAsset;
  embedding: number[];
}): KnowledgeChunkInput {
  if (input.asset.status !== 'active') {
    throw new Error('Only active training assets can be embedded');
  }
  if (!input.asset.scrubbedText) {
    throw new Error('Active training asset must have scrubbedText');
  }
  return {
    tenantId: input.asset.tenantId,
    scope: 'tenant',
    sourceType: 'vertical_training_asset',
    sourceId: input.asset.id,
    sourceVersion: resolveTrainingAssetSourceVersion(input.asset),
    content: input.asset.scrubbedText,
    contentScrubbed: input.asset.scrubbedText,
    embedding: input.embedding,
    embeddingModel: EMBEDDING_MODEL,
    chunkSchemaVersion: 1,
    metadata: {
      verticalType: input.asset.verticalType,
      assetKind: input.asset.assetKind,
      labels: input.asset.labels,
      provenance: input.asset.provenance,
    },
  };
}
