import type { EmbeddingProvider } from '../providers/openai-compatible';
import type {
  KnowledgeChunkRepository,
  KnowledgeChunkSourceType,
  SearchHit,
} from '../training/knowledge-chunks';

/**
 * retrieve-context — skill the inbound-CSR pipeline (and downstream
 * dispatcher tooling) calls to pull relevant grounded knowledge from
 * the per-tenant + global RAG corpus introduced in Phase 1.
 *
 * Phase 1 ships the skill as a standalone callable; it is NOT yet
 * wired into `context-builder.buildSourceContext` or the FSM
 * `intent_capture` state. Wiring lands in Phase 4a (context-builder
 * integration, behind `RAG_RETRIEVAL_ENABLED` flag) and Phase 4b (live
 * FSM integration, after we measure latency impact in 4a).
 *
 * The skill wraps two collaborators:
 *   1. `EmbeddingProvider` — turns the query text into a 1536-dim
 *      vector (currently OpenAI text-embedding-3-small, locked at the
 *      schema level).
 *   2. `KnowledgeChunkRepository.search` — runs the cosine-similarity
 *      lookup against the tenant + global tiers.
 *
 * Failure-soft: on embedding or repo error, returns
 * `{ status: 'unavailable', reason }` so callers can fall back to the
 * existing recency-only context-builder path without crashing the
 * larger task. Mirrors the AvailabilityFinder failure shape.
 */

export interface RetrieveContextInput {
  tenantId: string;
  /** Free-text query (typically the latest caller utterance or the operator's transcript). */
  queryText: string;
  /** Optional narrowing: e.g. only `proposal_correction` and `call_summary` for an appointment-rebook query. */
  sourceTypes?: KnowledgeChunkSourceType[];
  /** Default 5; capped at 50 by the repository. */
  k?: number;
  /** Cosine similarity floor in [0, 1]. Default 0.75. */
  minSimilarity?: number;
}

export type RetrieveContextResult =
  | { status: 'ok'; hits: SearchHit[] }
  | { status: 'no_hits' }
  | { status: 'unavailable'; reason: string };

export interface RetrieveContextDeps {
  embeddings: EmbeddingProvider;
  repository: KnowledgeChunkRepository;
}

export async function retrieveContext(
  input: RetrieveContextInput,
  deps: RetrieveContextDeps,
): Promise<RetrieveContextResult> {
  const queryText = input.queryText.trim();
  if (queryText.length === 0) {
    return { status: 'unavailable', reason: 'queryText is empty' };
  }

  let queryEmbedding: number[];
  try {
    const result = await deps.embeddings.createEmbedding(queryText);
    queryEmbedding = result.embedding;
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let hits: SearchHit[];
  try {
    hits = await deps.repository.search({
      tenantId: input.tenantId,
      queryEmbedding,
      sourceTypes: input.sourceTypes,
      k: input.k,
      minSimilarity: input.minSimilarity,
    });
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (hits.length === 0) return { status: 'no_hits' };
  return { status: 'ok', hits };
}
