import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import {
  AttachOutcomeInput,
  RecordEvalRunInput,
  RetrievalEvalRun,
  RetrievalEvalRunRepository,
} from './retrieval-eval-run';

interface RetrievalEvalRunRow {
  id: string;
  tenant_id: string;
  ai_run_id: string | null;
  query_text: string;
  retrieved_chunk_ids: string[];
  retrieved_scores: number[];
  downstream_proposal_id: string | null;
  downstream_outcome: string | null;
  created_at: Date;
}

function rowToRun(row: RetrievalEvalRunRow): RetrievalEvalRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    aiRunId: row.ai_run_id ?? undefined,
    queryText: row.query_text,
    retrievedChunkIds: row.retrieved_chunk_ids ?? [],
    retrievedScores: row.retrieved_scores ?? [],
    downstreamProposalId: row.downstream_proposal_id ?? undefined,
    downstreamOutcome: row.downstream_outcome ?? undefined,
    createdAt: row.created_at,
  };
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

export class PgRetrievalEvalRunRepository
  extends PgBaseRepository
  implements RetrievalEvalRunRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordRun(input: RecordEvalRunInput): Promise<RetrievalEvalRun> {
    validateInput(input);
    return this.withTenantTransaction(input.tenantId, async (client) => {
      const result = await client.query<RetrievalEvalRunRow>(
        `INSERT INTO retrieval_eval_runs (
           tenant_id, ai_run_id, query_text, retrieved_chunk_ids, retrieved_scores,
           downstream_proposal_id, downstream_outcome
         ) VALUES ($1, $2, $3, $4::uuid[], $5::real[], $6, $7)
         RETURNING *`,
        [
          input.tenantId,
          input.aiRunId ?? null,
          input.queryText,
          input.retrievedChunkIds,
          input.retrievedScores,
          input.downstreamProposalId ?? null,
          input.downstreamOutcome ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('retrieval_eval_runs: INSERT returned no row');
      return rowToRun(row);
    });
  }

  async attachOutcome(input: AttachOutcomeInput): Promise<RetrievalEvalRun | null> {
    return this.withTenantTransaction(input.tenantId, async (client) => {
      // COALESCE preserves prior values when the caller passes undefined,
      // so a partial update only touches the columns the caller supplied.
      const result = await client.query<RetrievalEvalRunRow>(
        `UPDATE retrieval_eval_runs
            SET downstream_proposal_id = COALESCE($3, downstream_proposal_id),
                downstream_outcome     = COALESCE($4, downstream_outcome)
          WHERE tenant_id = $1 AND id = $2
          RETURNING *`,
        [
          input.tenantId,
          input.evalRunId,
          input.downstreamProposalId ?? null,
          input.downstreamOutcome ?? null,
        ],
      );
      const row = result.rows[0];
      return row ? rowToRun(row) : null;
    });
  }

  async findById(tenantId: string, id: string): Promise<RetrievalEvalRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<RetrievalEvalRunRow>(
        `SELECT * FROM retrieval_eval_runs WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? rowToRun(row) : null;
    });
  }
}
