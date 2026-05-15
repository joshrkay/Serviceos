import type { KnowledgeChunkInput } from '../ai/training/knowledge-chunks';
import { EMBEDDING_MODEL } from '../ai/training/knowledge-chunks';
import type { VerticalTrainingAsset } from './training-assets';

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
    sourceVersion: Number.parseInt(input.asset.provenance.sourceVersion, 10) || 1,
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
