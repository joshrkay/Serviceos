/**
 * call_summaries repository — the end-of-call summary row `summarizeSession`
 * persists (A2).
 *
 * call_summaries is ENABLE + FORCE RLS
 * (`USING (tenant_id = current_setting('app.current_tenant_id')::UUID)`), so
 * the write goes through `withTenantTransaction`: BEGIN, `applyTenantContext`
 * (tenant GUC + the RLS-subject role), INSERT, COMMIT. A bare `pool.query`
 * ran as the privileged connection principal with no tenant context — outside
 * the database backstop entirely. The explicit `tenant_id = $1` value is the
 * usual belt and braces; the policy rejects any other tenant's id.
 */
import { PgBaseRepository } from '../../db/pg-base';

export interface CallSummaryRow {
  /**
   * voice_recordings.id when the session has a recording (P8-014); NULL for
   * sessions without one (in-app). The partial unique index on
   * (tenant_id, call_id) makes a retried summary for the same recording
   * collide instead of duplicating.
   */
  callId: string | null;
  summary: string;
  detectedIntent: string | null;
  /** proposal_ids is UUID[]. */
  proposalIds: string[];
  /** 0.0–1.0, NUMERIC(3,2). */
  qualityScore: number | null;
}

export interface CallSummaryRepository {
  create(tenantId: string, row: CallSummaryRow): Promise<{ id: string }>;
}

export class PgCallSummaryRepository extends PgBaseRepository implements CallSummaryRepository {
  async create(tenantId: string, row: CallSummaryRow): Promise<{ id: string }> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO call_summaries
           (tenant_id, call_id, summary, detected_intent, proposal_ids, quality_score)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, row.callId, row.summary, row.detectedIntent, row.proposalIds, row.qualityScore],
      );
      return { id: rows[0].id };
    });
  }
}
