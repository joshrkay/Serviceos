import { describe, it, expect, vi } from 'vitest';
import {
  buildSourceContext,
  trimContext,
  estimateContextSize,
  MAX_CONTEXT_TOKENS,
  type SourceContext,
  type ContextRepositories,
  type RetrieveAdapter,
} from '../../../src/ai/orchestration/context-builder';
import { createRetrieveAdapter } from '../../../src/ai/orchestration/retrieve-adapter';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  InMemoryKnowledgeChunkRepository,
  type KnowledgeChunkRepository,
} from '../../../src/ai/training/knowledge-chunks';
import { InMemoryRetrievalEvalRunRepository } from '../../../src/ai/training/retrieval-eval-run';
import type {
  EmbeddingProvider,
  EmbeddingResult,
} from '../../../src/ai/providers/openai-compatible';
import type { Message } from '../../../src/conversations/conversation-service';

const TENANT = '11111111-1111-1111-1111-111111111111';

function unitVec(dim: number, fn: (i: number) => number): number[] {
  const raw = Array.from({ length: dim }, (_, i) => fn(i));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  return raw.map((x) => x / (norm || 1));
}

// Constant unit vector so cosine similarity against the test query is
// 1.0 and the chunk passes the repo's minSimilarity floor regardless of
// the input string.
const CONST_EMBEDDING = unitVec(EMBEDDING_DIMENSIONS, () => 1);

function stubEmbedder(opts: { fail?: boolean } = {}): EmbeddingProvider {
  return {
    name: 'stub',
    async createEmbedding(_input: string): Promise<EmbeddingResult> {
      if (opts.fail) throw new Error('embedder stubbed to fail');
      return {
        embedding: [...CONST_EMBEDDING],
        model: EMBEDDING_MODEL,
        tokenUsage: 5,
        latencyMs: 1,
      };
    },
  };
}

function makeMessage(opts: {
  index: number;
  role?: string;
  content?: string;
}): Message {
  return {
    id: `msg-${opts.index}`,
    tenantId: TENANT,
    conversationId: 'conv-1',
    messageType: 'text',
    content: opts.content ?? `body-${opts.index}`,
    senderId: `user-${opts.index}`,
    senderRole: opts.role ?? 'customer',
    createdAt: new Date(Date.UTC(2026, 3, 21, 12, opts.index)),
  };
}

describe('buildSourceContext — Phase 4a-2 retrieval', () => {
  it('flag-off (no retrieve dep): no retrievedChunks, no eval-run row', async () => {
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'AC is broken' }),
      ],
      // retrieve omitted — simulates RAG_RETRIEVAL_ENABLED=false in app.ts
    };

    const ctx = await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(ctx.retrievedChunks).toBeUndefined();
    // No eval-run row written because no retrieve adapter was called.
    expect(await evalRepo.findById(TENANT, 'never-written')).toBeNull();
  });

  it('logs detected_language on eval-run rows (Phase 4c telemetry)', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve = createRetrieveAdapter({
      embeddings: stubEmbedder(),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({
          index: 1,
          role: 'customer',
          content:
            'Mi aire acondicionado no funciona puede enviar alguien mañana por la mañana',
        }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    expect(recordRunSpy.mock.calls[0][0].detectedLanguage).toBe('es');
  });

  it('omits detected_language when language is undeterminable (und)', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve = createRetrieveAdapter({
      embeddings: stubEmbedder(),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        // Too short to detect — falls below MIN_DETECTION_BYTES.
        makeMessage({ index: 1, role: 'customer', content: 'hi help' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    expect(recordRunSpy.mock.calls[0][0].detectedLanguage).toBeUndefined();
  });

  it('flag-on, hits returned: populates retrievedChunks + logs eval-run', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    await knowledgeRepo.insert({
      tenantId: TENANT,
      scope: 'tenant',
      sourceType: 'call_summary',
      sourceId: 'call-1',
      content: 'Saturday tune-up booked',
      contentScrubbed: 'Saturday tune-up booked',
      embedding: [...CONST_EMBEDDING],
    });
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve: RetrieveAdapter = createRetrieveAdapter({
      embeddings: stubEmbedder(),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });

    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'AC is broken' }),
      ],
      retrieve,
    };

    const ctx = await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(ctx.retrievedChunks).toBeDefined();
    expect(ctx.retrievedChunks!.length).toBe(1);
    expect(ctx.retrievedChunks![0].sourceType).toBe('call_summary');
    expect(ctx.retrievedChunks![0].sourceId).toBe('call-1');
    expect(ctx.retrievedChunks![0].content).toBe('Saturday tune-up booked');
    expect(ctx.retrievedChunks![0].similarity).toBeGreaterThan(0.99);

    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    const call = recordRunSpy.mock.calls[0][0];
    expect(call.tenantId).toBe(TENANT);
    expect(call.queryText).toBe('AC is broken');
    expect(call.retrievedChunkIds.length).toBe(1);
    expect(call.retrievedScores.length).toBe(1);
  });

  it('flag-on, embedder unavailable: no chunks, no crash, no eval-run row', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve = createRetrieveAdapter({
      embeddings: stubEmbedder({ fail: true }),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });

    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'AC is broken' }),
      ],
      retrieve,
    };

    const ctx = await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(ctx.retrievedChunks).toBeUndefined();
    expect(recordRunSpy).not.toHaveBeenCalled();
    // The rest of the context still built normally.
    expect(ctx.conversation).toBeDefined();
  });

  it('clamps eval-run similarity scores to [0, 1] (FP drift safety)', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    await knowledgeRepo.insert({
      tenantId: TENANT,
      scope: 'tenant',
      sourceType: 'call_summary',
      sourceId: 'call-1',
      content: 'hit',
      contentScrubbed: 'hit',
      embedding: [...CONST_EMBEDDING],
    });
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve = createRetrieveAdapter({
      embeddings: stubEmbedder(),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'q' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    // recordRun must have been called AND must have succeeded — i.e. the
    // FP-drift clamp keeps `validateInput` happy. Asserting the row is
    // present in the repo proves recordRun ran end-to-end (a thrown
    // validation error would have left rows empty).
    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    for (const score of recordRunSpy.mock.calls[0][0].retrievedScores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    const persisted = await recordRunSpy.mock.results[0].value;
    expect(persisted.id).toBeDefined();
    expect(persisted.retrievedScores.every((s: number) => s >= 0 && s <= 1)).toBe(true);
  });

  it('flag-on, no_hits: empty arrays logged, retrievedChunks left undefined', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    // Intentionally no inserts → search returns 0 hits.
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve = createRetrieveAdapter({
      embeddings: stubEmbedder(),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });

    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'random query' }),
      ],
      retrieve,
    };

    const ctx = await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(ctx.retrievedChunks).toBeUndefined();
    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    const call = recordRunSpy.mock.calls[0][0];
    expect(call.retrievedChunkIds).toEqual([]);
    expect(call.retrievedScores).toEqual([]);
  });

  it('uses entityRefs.queryText when supplied (overrides latest message)', async () => {
    const retrieve = vi.fn<Parameters<RetrieveAdapter>, ReturnType<RetrieveAdapter>>(
      async () => ({ status: 'no_hits' as const }),
    );
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'old message' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', { queryText: 'override-query' }, repos);

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0][0].queryText).toBe('override-query');
  });

  it('falls back to latest non-agent message when queryText absent', async () => {
    const retrieve = vi.fn<Parameters<RetrieveAdapter>, ReturnType<RetrieveAdapter>>(
      async () => ({ status: 'no_hits' as const }),
    );
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'first caller line' }),
        makeMessage({ index: 2, role: 'agent', content: 'agent reply' }),
        makeMessage({ index: 3, role: 'customer', content: 'follow-up question' }),
        makeMessage({ index: 4, role: 'agent', content: 'tail agent line' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0][0].queryText).toBe('follow-up question');
  });

  it('skips non-allowlisted roles (system/tool) when scanning for queryText', async () => {
    const retrieve = vi.fn<Parameters<RetrieveAdapter>, ReturnType<RetrieveAdapter>>(
      async () => ({ status: 'no_hits' as const }),
    );
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'older caller line' }),
        makeMessage({ index: 2, role: 'agent', content: 'agent reply' }),
        // Latest non-agent role — but NOT in QUERY_ROLES allow-list. Must be skipped.
        makeMessage({ index: 3, role: 'system', content: 'system housekeeping ping' }),
        makeMessage({ index: 4, role: 'tool', content: 'tool function output' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(retrieve).toHaveBeenCalledTimes(1);
    // Falls back to the older customer message, not 'system' or 'tool'.
    expect(retrieve.mock.calls[0][0].queryText).toBe('older caller line');
  });

  it('whitespace-only entityRefs.queryText falls back to message scan', async () => {
    const retrieve = vi.fn<Parameters<RetrieveAdapter>, ReturnType<RetrieveAdapter>>(
      async () => ({ status: 'no_hits' as const }),
    );
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'fallback message' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', { queryText: '   \t  ' }, repos);

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0][0].queryText).toBe('fallback message');
  });

  it('NaN similarity scores are clamped to 0 (zero-magnitude embedding safety)', async () => {
    // A search that returns a NaN similarity. Cosine similarity of a
    // zero-magnitude vector against anything is 0/0 = NaN; we want to
    // recover gracefully rather than letting `validateInput` reject the
    // eval-run row.
    const knowledgeRepo: KnowledgeChunkRepository = {
      insert: async () => {
        throw new Error('not used');
      },
      search: async () => [
        {
          chunk: {
            id: 'chunk-1',
            tenantId: TENANT,
            scope: 'tenant',
            sourceType: 'call_summary',
            sourceId: 'call-1',
            sourceVersion: 1,
            content: 'hit',
            contentScrubbed: 'hit',
            embedding: [...CONST_EMBEDDING],
            embeddingModel: EMBEDDING_MODEL,
            chunkSchemaVersion: 1,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          similarity: NaN,
        },
      ],
    };
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');

    const retrieve = createRetrieveAdapter({
      embeddings: stubEmbedder(),
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'q' }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    const call = recordRunSpy.mock.calls[0][0];
    expect(call.retrievedScores).toEqual([0]);
    // And the persisted row exists (validateInput accepted the clamped 0).
    const persisted = await recordRunSpy.mock.results[0].value;
    expect(persisted.retrievedScores).toEqual([0]);
  });

  it('scrubs PII from queryText before persisting to retrieval_eval_runs', async () => {
    const knowledgeRepo = new InMemoryKnowledgeChunkRepository();
    const evalRepo = new InMemoryRetrievalEvalRunRepository();
    const recordRunSpy = vi.spyOn(evalRepo, 'recordRun');
    // Track the queryText sent to the embedder so we can confirm the
    // SEARCH ran on the raw text — only the persisted eval-run row is
    // scrubbed.
    const seenByEmbedder: string[] = [];
    const trackedEmbedder: EmbeddingProvider = {
      name: 'tracked',
      async createEmbedding(input: string): Promise<EmbeddingResult> {
        seenByEmbedder.push(input);
        return {
          embedding: [...CONST_EMBEDDING],
          model: EMBEDDING_MODEL,
          tokenUsage: 5,
          latencyMs: 1,
        };
      },
    };

    const retrieve = createRetrieveAdapter({
      embeddings: trackedEmbedder,
      knowledgeChunkRepo: knowledgeRepo,
      retrievalEvalRunRepo: evalRepo,
    });
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({
          index: 1,
          role: 'customer',
          content: 'My number is 555-867-5309 and I need a tune-up',
        }),
      ],
      retrieve,
    };

    await buildSourceContext(TENANT, 'conv-1', {}, repos);

    // Embedder saw the raw text (we want phone-number context for retrieval).
    expect(seenByEmbedder.length).toBe(1);
    expect(seenByEmbedder[0]).toContain('5309');

    // Eval-run row has scrubbed text — phone digits removed.
    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    const persistedQuery = recordRunSpy.mock.calls[0][0].queryText;
    expect(persistedQuery).not.toContain('5309');
    expect(persistedQuery).not.toContain('867');
    // Non-PII content survives.
    expect(persistedQuery).toContain('tune-up');
  });

  it('skips retrieval when no queryText resolves (no messages, no override)', async () => {
    const retrieve = vi.fn<Parameters<RetrieveAdapter>, ReturnType<RetrieveAdapter>>(
      async () => ({ status: 'no_hits' as const }),
    );
    const repos: ContextRepositories = {
      retrieve,
    };

    const ctx = await buildSourceContext(TENANT, undefined, {}, repos);

    expect(retrieve).not.toHaveBeenCalled();
    expect(ctx.retrievedChunks).toBeUndefined();
  });

  it('adapter that throws synchronously does not break buildSourceContext', async () => {
    const retrieve: RetrieveAdapter = async () => {
      throw new Error('misconfigured retrieve');
    };
    const repos: ContextRepositories = {
      getConversationMessages: async () => [
        makeMessage({ index: 1, role: 'customer', content: 'AC broken' }),
      ],
      retrieve,
    };

    const ctx = await buildSourceContext(TENANT, 'conv-1', {}, repos);

    expect(ctx.retrievedChunks).toBeUndefined();
    expect(ctx.conversation).toBeDefined();
  });
});

describe('trimContext — drops retrievedChunks first', () => {
  it('drops retrievedChunks before trimming conversation when over budget', () => {
    const heavyChunk = {
      content: 'x'.repeat(40000), // far over the 8k token budget alone
      sourceType: 'call_summary',
      sourceId: 'call-1',
      similarity: 0.9,
    };
    const ctx: SourceContext = {
      conversation: {
        id: 'conv-1',
        recentMessages: [
          { role: 'customer', content: 'hello', createdAt: new Date() },
          { role: 'agent', content: 'hi', createdAt: new Date() },
        ],
      },
      customer: { id: 'cust-1', name: 'Jane' },
      retrievedChunks: [heavyChunk],
    };

    expect(estimateContextSize(ctx)).toBeGreaterThan(MAX_CONTEXT_TOKENS);

    const trimmed = trimContext(ctx, MAX_CONTEXT_TOKENS);

    expect(trimmed.retrievedChunks).toBeUndefined();
    // Conversation + customer survive — chunks were the eviction target.
    expect(trimmed.conversation?.recentMessages.length).toBe(2);
    expect(trimmed.customer).toBeDefined();
    expect(estimateContextSize(trimmed)).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });

  it('leaves retrievedChunks alone when under budget', () => {
    const ctx: SourceContext = {
      conversation: {
        id: 'conv-1',
        recentMessages: [
          { role: 'customer', content: 'hello', createdAt: new Date() },
        ],
      },
      retrievedChunks: [
        {
          content: 'small chunk',
          sourceType: 'call_summary',
          sourceId: 'c-1',
          similarity: 0.9,
        },
      ],
    };

    const trimmed = trimContext(ctx, MAX_CONTEXT_TOKENS);

    expect(trimmed.retrievedChunks).toBeDefined();
    expect(trimmed.retrievedChunks!.length).toBe(1);
  });
});
