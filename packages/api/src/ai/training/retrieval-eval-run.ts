/**
 * retrieval_eval_runs — quality measurement for the RAG corpus.
 *
 * Built into the foundation from day one (per the approved Phase 2 plan)
 * so we can answer "did retrieval actually help?" before flipping the
 * `RAG_RETRIEVAL_ENABLED` default in Phase 4a. Each row records:
 *
 *   - the query text (typically a caller utterance or operator prompt)
 *   - the chunk IDs we returned and their cosine similarity scores
 *   - the proposal that resulted from this LLM run (if any)
 *   - the downstream outcome (joined later from proposal_analytics or
 *     voice_recordings.outcome)
 *
 * With those four columns we can compute, per-tenant or globally:
 *
 *   - dispatcher edit rate by retrieved-chunk source_type
 *   - intent classification accuracy with vs. without retrieval (A/B)
 *   - retrieval precision: chunks_used_in_response / chunks_returned
 *   - retrieval recall over time as the corpus grows
 *
 * No caller in main writes this surface yet; the retrieve-context skill
 * will start logging rows behind the `RAG_RETRIEVAL_ENABLED` flag in
 * Phase 4a.
 */

import { randomUUID } from 'crypto';

export interface RetrievalEvalRun {
  id: string;
  tenantId: string;
  /** The ai_runs row this retrieval was bound to, if any. */
  aiRunId?: string;
  queryText: string;
  retrievedChunkIds: string[];
  /** Same length as retrievedChunkIds; cosine similarity in [0, 1]. */
  retrievedScores: number[];
  /** Filled in retroactively when the downstream proposal lands. */
  downstreamProposalId?: string;
  /** Free-form for now; expected values mirror proposal_analytics.outcome. */
  downstreamOutcome?: string;
  createdAt: Date;
}

export interface RecordEvalRunInput {
  tenantId: string;
  queryText: string;
  retrievedChunkIds: string[];
  retrievedScores: number[];
  aiRunId?: string;
  downstreamProposalId?: string;
  downstreamOutcome?: string;
}

export interface AttachOutcomeInput {
  tenantId: string;
  evalRunId: string;
  downstreamProposalId?: string;
  downstreamOutcome?: string;
}

export interface RetrievalEvalRunRepository {
  recordRun(input: RecordEvalRunInput): Promise<RetrievalEvalRun>;
  /**
   * Attach the downstream proposal + outcome retroactively. Called by
   * the proposal-correction-worker (Phase 4a) once a proposal lands.
   */
  attachOutcome(input: AttachOutcomeInput): Promise<RetrievalEvalRun | null>;
  findById(tenantId: string, id: string): Promise<RetrievalEvalRun | null>;
}

function validateInput(input: RecordEvalRunInput): void {
  if (!input.tenantId) throw new Error('retrieval_eval_runs: tenantId is required');
  if (input.queryText.length === 0) {
    throw new Error('retrieval_eval_runs: queryText must be non-empty');
  }
  if (input.retrievedChunkIds.length !== input.retrievedScores.length) {
    throw new Error(
      `retrieval_eval_runs: chunk-id / score length mismatch (${input.retrievedChunkIds.length} vs ${input.retrievedScores.length})`,
    );
  }
  for (const score of input.retrievedScores) {
    if (Number.isNaN(score) || score < 0 || score > 1) {
      throw new Error(`retrieval_eval_runs: scores must be in [0, 1] (got ${score})`);
    }
  }
}

export class InMemoryRetrievalEvalRunRepository implements RetrievalEvalRunRepository {
  private readonly rows: RetrievalEvalRun[] = [];

  async recordRun(input: RecordEvalRunInput): Promise<RetrievalEvalRun> {
    validateInput(input);
    const row: RetrievalEvalRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      aiRunId: input.aiRunId,
      queryText: input.queryText,
      retrievedChunkIds: [...input.retrievedChunkIds],
      retrievedScores: [...input.retrievedScores],
      downstreamProposalId: input.downstreamProposalId,
      downstreamOutcome: input.downstreamOutcome,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async attachOutcome(input: AttachOutcomeInput): Promise<RetrievalEvalRun | null> {
    const row = this.rows.find((r) => r.tenantId === input.tenantId && r.id === input.evalRunId);
    if (!row) return null;
    if (input.downstreamProposalId !== undefined) {
      row.downstreamProposalId = input.downstreamProposalId;
    }
    if (input.downstreamOutcome !== undefined) {
      row.downstreamOutcome = input.downstreamOutcome;
    }
    return { ...row };
  }

  async findById(tenantId: string, id: string): Promise<RetrievalEvalRun | null> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    return row ? { ...row } : null;
  }
}
