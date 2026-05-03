import type { EmbeddingProvider } from '../providers/openai-compatible';
import type { KnowledgeChunkRepository } from '../training/knowledge-chunks';
import type { RetrievalEvalRunRepository } from '../training/retrieval-eval-run';
import { scrubPii } from '../training/scrub';
import {
  retrieveContext,
  type RetrieveContextResult,
} from '../skills/retrieve-context';
import type { RetrieveAdapter } from './context-builder';

/**
 * Phase 4a-2 reader wiring. Builds the `RetrieveAdapter` consumed by
 * `buildSourceContext` from the underlying embedder + chunk repo.
 * Records every call into `retrieval_eval_runs` (when a repo is wired)
 * so we can later correlate retrieved chunks with downstream proposal
 * outcomes via `proposal-correction-worker`'s `attachOutcome`.
 *
 * The adapter never throws — `retrieveContext` already returns
 * `{ status: 'unavailable' }` on failure. The eval-run write is
 * fire-and-forget: failures are logged but never surface to the caller,
 * matching the failure-soft contract on the rest of the retrieval path.
 *
 * Construction is intentionally split from `process.env` lookup. Callers
 * (typically `app.ts`) gate this behind `RAG_RETRIEVAL_ENABLED === 'true'`
 * — when the flag is off, `buildSourceContext` is invoked without a
 * `retrieve` dep at all and the legacy path runs unchanged.
 */
export interface CreateRetrieveAdapterOptions {
  embeddings: EmbeddingProvider;
  knowledgeChunkRepo: KnowledgeChunkRepository;
  /**
   * Optional eval-run logger. When supplied, every retrieval call writes
   * a row to `retrieval_eval_runs` capturing the query and the chunk IDs
   * that came back; the proposal-correction-worker later annotates the
   * row with the dispatcher outcome to close the eval loop.
   */
  retrievalEvalRunRepo?: RetrievalEvalRunRepository;
}

export function createRetrieveAdapter(
  opts: CreateRetrieveAdapterOptions,
): RetrieveAdapter {
  const { embeddings, knowledgeChunkRepo, retrievalEvalRunRepo } = opts;
  return async (input) => {
    const result: RetrieveContextResult = await retrieveContext(
      {
        tenantId: input.tenantId,
        queryText: input.queryText,
        sourceTypes: input.sourceTypes,
        k: input.k,
        minSimilarity: input.minSimilarity,
      },
      {
        embeddings,
        repository: knowledgeChunkRepo,
      },
    );

    // Eval-run logging policy: log on `ok` (chunks + scores) and on
    // `no_hits` (empty arrays — still a meaningful signal: "we tried,
    // found nothing"). Skip on `unavailable` because the underlying
    // embedder or repo failed and the row would be misleading; the
    // failure is already returned to the caller via the result.
    if (
      retrievalEvalRunRepo &&
      (result.status === 'ok' || result.status === 'no_hits')
    ) {
      const retrievedChunkIds =
        result.status === 'ok' ? result.hits.map((h) => h.chunk.id) : [];
      // Clamp to [0, 1]. Cosine of two unit vectors is mathematically in
      // that range, but floating-point arithmetic can produce
      // 1.0000000000000002 — which trips `validateInput` on the eval-run
      // repo and turns every row into a logged failure. The explicit
      // NaN→0 fallback covers the case where a zero-magnitude embedding
      // produces a divide-by-zero similarity (treats unknown signal as
      // "no match" rather than "perfect match").
      const retrievedScores =
        result.status === 'ok'
          ? result.hits.map((h) =>
              Number.isNaN(h.similarity)
                ? 0
                : Math.max(0, Math.min(1, h.similarity)),
            )
          : [];
      // Scrub PII from queryText before persisting. The search itself
      // ran against the raw text — phone numbers and addresses carry
      // semantic signal we want for retrieval — but the eval-run table
      // is a long-lived audit surface that ops humans review later, so
      // it gets the regex-scrubbed variant. Without `knownEntities`
      // here, the layered scrubber catches phones/emails/addresses by
      // pattern; names slip through. Acceptable for an eval-run row
      // (we're not training on `query_text`); compliance-grade scrub
      // requires the caller to pass `knownEntities` via a richer
      // RetrieveAdapter signature, which Phase 4b can introduce when
      // it has the customer-id context to source them.
      const scrubbedQueryText = scrubPii(input.queryText).scrubbed;
      try {
        await retrievalEvalRunRepo.recordRun({
          tenantId: input.tenantId,
          queryText: scrubbedQueryText,
          retrievedChunkIds,
          retrievedScores,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('retrieve-adapter: recordRun failed', {
          tenantId: input.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  };
}
