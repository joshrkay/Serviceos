import { describe, it, expect, vi } from 'vitest';
import { retrieveContext } from '../../../src/ai/skills/retrieve-context';
import {
  InMemoryKnowledgeChunkRepository,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
} from '../../../src/ai/training/knowledge-chunks';
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../../../src/ai/providers/openai-compatible';

const TENANT = '11111111-1111-1111-1111-111111111111';

function unitVec(dim: number, fn: (i: number) => number): number[] {
  const raw = Array.from({ length: dim }, (_, i) => fn(i));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / (norm || 1));
}

function stubEmbedder(vector: number[] | Error): EmbeddingProvider {
  return {
    name: 'stub',
    createEmbedding: vi.fn(async (): Promise<EmbeddingResult> => {
      if (vector instanceof Error) throw vector;
      return {
        embedding: vector,
        model: EMBEDDING_MODEL,
        tokenUsage: 5,
        latencyMs: 1,
      };
    }),
  };
}

describe('retrieveContext', () => {
  it('happy path — returns hits when corpus contains a similar chunk', async () => {
    const v = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
    const repo = new InMemoryKnowledgeChunkRepository();
    await repo.insert({
      tenantId: TENANT,
      scope: 'tenant',
      sourceType: 'call_summary',
      sourceId: 'call-1',
      content: 'Customer wanted Saturday morning AC tune-up',
      contentScrubbed: 'Customer wanted Saturday morning AC tune-up',
      embedding: v,
    });

    const result = await retrieveContext(
      { tenantId: TENANT, queryText: 'AC tune-up timing question' },
      { embeddings: stubEmbedder(v), repository: repo },
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].chunk.sourceId).toBe('call-1');
    expect(result.hits[0].similarity).toBeCloseTo(1, 6);
  });

  it('no_hits when corpus is empty', async () => {
    const v = unitVec(EMBEDDING_DIMENSIONS, () => 1);
    const repo = new InMemoryKnowledgeChunkRepository();

    const result = await retrieveContext(
      { tenantId: TENANT, queryText: 'anything' },
      { embeddings: stubEmbedder(v), repository: repo },
    );

    expect(result.status).toBe('no_hits');
  });

  it('no_hits when minSimilarity floor excludes everything', async () => {
    const target = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 0 ? 1 : 0));
    const orthogonal = unitVec(EMBEDDING_DIMENSIONS, (i) => (i === 1 ? 1 : 0));
    const repo = new InMemoryKnowledgeChunkRepository();
    await repo.insert({
      tenantId: TENANT,
      scope: 'tenant',
      sourceType: 'call_summary',
      sourceId: 'call-1',
      content: 'unrelated',
      contentScrubbed: 'unrelated',
      embedding: orthogonal,
    });

    const result = await retrieveContext(
      { tenantId: TENANT, queryText: 'q', minSimilarity: 0.5 },
      { embeddings: stubEmbedder(target), repository: repo },
    );

    expect(result.status).toBe('no_hits');
  });

  it('unavailable when embedding fails', async () => {
    const repo = new InMemoryKnowledgeChunkRepository();
    const result = await retrieveContext(
      { tenantId: TENANT, queryText: 'q' },
      { embeddings: stubEmbedder(new Error('rate-limited')), repository: repo },
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('rate-limited');
  });

  it('unavailable when repo search throws', async () => {
    const v = unitVec(EMBEDDING_DIMENSIONS, () => 1);
    const repo = {
      insert: vi.fn(),
      search: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    const result = await retrieveContext(
      { tenantId: TENANT, queryText: 'q' },
      { embeddings: stubEmbedder(v), repository: repo },
    );
    expect(result.status).toBe('unavailable');
  });

  it('unavailable when queryText is empty', async () => {
    const v = unitVec(EMBEDDING_DIMENSIONS, () => 1);
    const repo = new InMemoryKnowledgeChunkRepository();
    const result = await retrieveContext(
      { tenantId: TENANT, queryText: '   ' },
      { embeddings: stubEmbedder(v), repository: repo },
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toContain('empty');
  });

  it('forwards sourceTypes filter to the repository', async () => {
    const v = unitVec(EMBEDDING_DIMENSIONS, () => 1);
    const repo = {
      insert: vi.fn(),
      search: vi.fn(async () => []),
    };

    await retrieveContext(
      {
        tenantId: TENANT,
        queryText: 'q',
        sourceTypes: ['proposal_correction', 'call_summary'],
        k: 7,
        minSimilarity: 0.8,
      },
      { embeddings: stubEmbedder(v), repository: repo },
    );

    expect(repo.search).toHaveBeenCalledWith({
      tenantId: TENANT,
      queryEmbedding: v,
      sourceTypes: ['proposal_correction', 'call_summary'],
      k: 7,
      minSimilarity: 0.8,
    });
  });
});
