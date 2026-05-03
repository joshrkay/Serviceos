import { describe, it, expect } from 'vitest';
import {
  InMemoryKnowledgeChunkRepository,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  cosineSimilarity,
  type KnowledgeChunkInput,
} from '../../../src/ai/training/knowledge-chunks';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function unitVec(dim: number, fn: (i: number) => number): number[] {
  const raw = Array.from({ length: dim }, (_, i) => fn(i));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / (norm || 1));
}

function tenantInput(
  tenantId: string,
  sourceId: string,
  embedding: number[],
  overrides: Partial<KnowledgeChunkInput> = {},
): KnowledgeChunkInput {
  return {
    tenantId,
    scope: 'tenant',
    sourceType: 'call_summary',
    sourceId,
    content: `content-${sourceId}`,
    contentScrubbed: `scrubbed-${sourceId}`,
    embedding,
    ...overrides,
  };
}

function globalInput(
  sourceId: string,
  embedding: number[],
  overrides: Partial<KnowledgeChunkInput> = {},
): KnowledgeChunkInput {
  return {
    tenantId: null,
    scope: 'global',
    sourceType: 'vertical_terminology',
    sourceId,
    content: `global-${sourceId}`,
    contentScrubbed: `global-${sourceId}`,
    embedding,
    ...overrides,
  };
}

describe('InMemoryKnowledgeChunkRepository', () => {
  describe('insert validation', () => {
    it('rejects embedding with wrong dimensions', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      await expect(
        repo.insert(tenantInput(TENANT_A, 'a', [1, 2, 3])),
      ).rejects.toThrow(/embedding length/);
    });

    it('rejects scope=tenant with null tenantId', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      await expect(
        repo.insert({
          tenantId: null,
          scope: 'tenant',
          sourceType: 'call_summary',
          sourceId: 'x',
          content: 'c',
          contentScrubbed: 'c',
          embedding: unitVec(EMBEDDING_DIMENSIONS, () => 1),
        }),
      ).rejects.toThrow(/scope=tenant requires non-null tenantId/);
    });

    it('rejects scope=global with non-null tenantId', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      await expect(
        repo.insert({
          tenantId: TENANT_A,
          scope: 'global',
          sourceType: 'vertical_terminology',
          sourceId: 'x',
          content: 'c',
          contentScrubbed: 'c',
          embedding: unitVec(EMBEDDING_DIMENSIONS, () => 1),
        }),
      ).rejects.toThrow(/scope=global requires null tenantId/);
    });

    it('rejects mismatched embedding model (v1 lock)', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      await expect(
        repo.insert(
          tenantInput(TENANT_A, 'a', unitVec(EMBEDDING_DIMENSIONS, () => 1), {
            embeddingModel: 'text-embedding-3-large' as never,
          }),
        ),
      ).rejects.toThrow(/embedding_model must be/);
    });

    it('defaults embeddingModel to text-embedding-3-small', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const chunk = await repo.insert(tenantInput(TENANT_A, 'a', unitVec(EMBEDDING_DIMENSIONS, () => 1)));
      expect(chunk.embeddingModel).toBe(EMBEDDING_MODEL);
    });
  });

  describe('idempotency', () => {
    it('upserts on (scope, sourceType, sourceId, sourceVersion) collision', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v1 = unitVec(EMBEDDING_DIMENSIONS, () => 1);
      const first = await repo.insert(
        tenantInput(TENANT_A, 'shared', v1, { content: 'first', contentScrubbed: 'first' }),
      );
      const second = await repo.insert(
        tenantInput(TENANT_A, 'shared', v1, { content: 'second', contentScrubbed: 'second' }),
      );
      expect(second.id).toBe(first.id);
      expect(second.content).toBe('second');
      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    });

    it('treats different sourceVersions as distinct rows', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v1 = unitVec(EMBEDDING_DIMENSIONS, () => 1);
      const a = await repo.insert(tenantInput(TENANT_A, 'shared', v1, { sourceVersion: 1 }));
      const b = await repo.insert(tenantInput(TENANT_A, 'shared', v1, { sourceVersion: 2 }));
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('search — tenant isolation', () => {
    it('does not return tenant B chunks when tenant A queries', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
      await repo.insert(tenantInput(TENANT_B, 'tb-1', v, { content: 'tenant-B-secret' }));

      const hits = await repo.search({ tenantId: TENANT_A, queryEmbedding: v, k: 5 });
      expect(hits).toEqual([]);
    });

    it('returns tenant A chunks when tenant A queries', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
      await repo.insert(tenantInput(TENANT_A, 'ta-1', v, { content: 'tenant-A-data' }));

      const hits = await repo.search({ tenantId: TENANT_A, queryEmbedding: v, k: 5 });
      expect(hits.length).toBe(1);
      expect(hits[0].chunk.content).toBe('tenant-A-data');
    });

    it('returns global chunks for any tenant', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
      await repo.insert(globalInput('term-1', v, { content: 'global-term' }));

      const hitsA = await repo.search({ tenantId: TENANT_A, queryEmbedding: v });
      const hitsB = await repo.search({ tenantId: TENANT_B, queryEmbedding: v });
      expect(hitsA.length).toBe(1);
      expect(hitsB.length).toBe(1);
      expect(hitsA[0].chunk.scope).toBe('global');
    });

    it('returns both tenant-scoped + global hits in a single query', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
      await repo.insert(tenantInput(TENANT_A, 'ta-1', v));
      await repo.insert(globalInput('term-1', v));
      await repo.insert(tenantInput(TENANT_B, 'tb-1', v)); // should be filtered out

      const hits = await repo.search({ tenantId: TENANT_A, queryEmbedding: v, k: 10 });
      expect(hits.length).toBe(2);
      const scopes = hits.map((h) => h.chunk.scope).sort();
      expect(scopes).toEqual(['global', 'tenant']);
    });
  });

  describe('search — ranking + filters', () => {
    it('orders results by descending cosine similarity', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const target = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
      const orthogonal = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 1 ? 1 : 0));
      const close = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 0.95 : i === 1 ? 0.05 : 0));

      await repo.insert(tenantInput(TENANT_A, 'orthogonal', orthogonal));
      await repo.insert(tenantInput(TENANT_A, 'close', close));
      await repo.insert(tenantInput(TENANT_A, 'exact', target));

      const hits = await repo.search({
        tenantId: TENANT_A,
        queryEmbedding: target,
        k: 5,
        minSimilarity: 0,
      });
      expect(hits.map((h) => h.chunk.sourceId)).toEqual(['exact', 'close', 'orthogonal']);
      expect(hits[0].similarity).toBeGreaterThan(hits[1].similarity);
      expect(hits[1].similarity).toBeGreaterThan(hits[2].similarity);
    });

    it('honours minSimilarity floor', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const target = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
      const orthogonal = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 1 ? 1 : 0));
      await repo.insert(tenantInput(TENANT_A, 'orthogonal', orthogonal));

      const hits = await repo.search({
        tenantId: TENANT_A,
        queryEmbedding: target,
        minSimilarity: 0.75,
      });
      expect(hits).toEqual([]);
    });

    it('honours k cap', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v = unitVec(EMBEDDING_DIMENSIONS, () => 1);
      for (let i = 0; i < 10; i++) {
        await repo.insert(tenantInput(TENANT_A, `s-${i}`, v));
      }
      const hits = await repo.search({ tenantId: TENANT_A, queryEmbedding: v, k: 3, minSimilarity: 0 });
      expect(hits.length).toBe(3);
    });

    it('filters by sourceTypes', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      const v = unitVec(EMBEDDING_DIMENSIONS, () => 1);
      await repo.insert(tenantInput(TENANT_A, 'a', v, { sourceType: 'call_summary' }));
      await repo.insert(tenantInput(TENANT_A, 'b', v, { sourceType: 'proposal_correction' }));
      await repo.insert(tenantInput(TENANT_A, 'c', v, { sourceType: 'catalog_item' }));

      const hits = await repo.search({
        tenantId: TENANT_A,
        queryEmbedding: v,
        sourceTypes: ['call_summary', 'proposal_correction'],
        k: 10,
        minSimilarity: 0,
      });
      expect(hits.map((h) => h.chunk.sourceType).sort()).toEqual([
        'call_summary',
        'proposal_correction',
      ]);
    });

    it('rejects search with mismatched embedding dimensions', async () => {
      const repo = new InMemoryKnowledgeChunkRepository();
      await expect(
        repo.search({ tenantId: TENANT_A, queryEmbedding: [1, 2, 3] }),
      ).rejects.toThrow(/embedding length/);
    });
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal unit vectors', () => {
    const a = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
    const b = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 1 ? 1 : 0));
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('throws on dim mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dim mismatch/);
  });
});
