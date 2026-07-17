import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  AiRun,
  AiRunStatus,
  AiRunRepository,
} from './ai-run';

/**
 * Map a raw `ai_runs` row to the AiRun domain type.
 * pg returns JSONB columns as already-parsed JS values — no JSON.parse needed.
 */
function mapRow(row: Record<string, unknown>): AiRun {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    taskType: row.task_type as string,
    model: row.model as string,
    promptVersionId: (row.prompt_version_id as string | null) ?? undefined,
    inputSnapshot: row.input_snapshot as Record<string, unknown>,
    outputSnapshot: (row.output_snapshot as Record<string, unknown> | null) ?? undefined,
    status: row.status as AiRunStatus,
    errorMessage: (row.error_message as string | null) ?? undefined,
    startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
    tokenUsage: (row.token_usage as { input?: number; output?: number; total?: number } | null) ?? undefined,
    costMicroCents: row.cost_micro_cents != null ? Number(row.cost_micro_cents) : undefined,
    correlationId: (row.correlation_id as string | null) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Postgres-backed repository for AI runs (P2-027).
 *
 * Tenant isolation is enforced two ways:
 *   1. RLS via `app.current_tenant_id` (set by `withTenant`).
 *   2. Defense-in-depth `WHERE tenant_id = $N` in every query.
 */
export class PgAiRunRepository extends PgBaseRepository implements AiRunRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(run: AiRun): Promise<AiRun> {
    return this.withTenant(run.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO ai_runs
           (id, tenant_id, task_type, model, prompt_version_id,
            input_snapshot, output_snapshot, status, error_message,
            started_at, completed_at, duration_ms, token_usage,
            correlation_id, created_by, created_at, cost_micro_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           output_snapshot = EXCLUDED.output_snapshot,
           error_message = EXCLUDED.error_message,
           started_at = EXCLUDED.started_at,
           completed_at = EXCLUDED.completed_at,
           duration_ms = EXCLUDED.duration_ms,
           token_usage = EXCLUDED.token_usage,
           cost_micro_cents = EXCLUDED.cost_micro_cents
         RETURNING *`,
        [
          run.id,
          run.tenantId,
          run.taskType,
          run.model,
          run.promptVersionId ?? null,
          JSON.stringify(run.inputSnapshot),
          run.outputSnapshot ? JSON.stringify(run.outputSnapshot) : null,
          run.status,
          run.errorMessage ?? null,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.durationMs ?? null,
          run.tokenUsage ? JSON.stringify(run.tokenUsage) : null,
          run.correlationId ?? null,
          run.createdBy,
          run.createdAt,
          run.costMicroCents ?? null,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<AiRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM ai_runs
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, id]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByTaskType(tenantId: string, taskType: string): Promise<AiRun[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM ai_runs
         WHERE tenant_id = $1 AND task_type = $2
         ORDER BY created_at DESC`,
        [tenantId, taskType]
      );
      return result.rows.map(mapRow);
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: AiRunStatus,
    result?: {
      outputSnapshot?: Record<string, unknown>;
      error?: string;
      tokenUsage?: { input?: number; output?: number; total?: number };
      completedAt?: Date;
      durationMs?: number;
      costMicroCents?: number | null;
      model?: string;
    }
  ): Promise<AiRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const isTerminal = status === 'completed' || status === 'failed';

      // Use caller-supplied timing when present (gateway is the source of truth);
      // fall back to DB-computed values for backward compat with other callers.
      const completedAt = isTerminal
        ? (result?.completedAt ?? new Date())
        : null;
      const hasDurationMs = isTerminal && result?.durationMs !== undefined;
      // costMicroCents is legitimately `null` (priced-but-unknown model), so —
      // like durationMs above — a presence flag distinguishes "set to null"
      // from "field omitted, leave the existing value alone"; COALESCE alone
      // can't express that distinction.
      const hasCostMicroCents = result != null && 'costMicroCents' in result;

      const queryResult = await client.query(
        `UPDATE ai_runs
         SET
           status = $3,
           completed_at = CASE WHEN $4 THEN $5::timestamptz ELSE completed_at END,
           output_snapshot = COALESCE($6::jsonb, output_snapshot),
           error_message = COALESCE($7, error_message),
           token_usage = COALESCE($8::jsonb, token_usage),
           duration_ms = CASE
             WHEN $4 AND $9 THEN $10
             WHEN $4 AND started_at IS NOT NULL THEN
               EXTRACT(EPOCH FROM ($5::timestamptz - started_at)) * 1000
             ELSE duration_ms
           END,
           cost_micro_cents = CASE WHEN $11 THEN $12 ELSE cost_micro_cents END,
           model = COALESCE($13, model)
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          tenantId,
          id,
          status,
          isTerminal,
          completedAt,
          result?.outputSnapshot ? JSON.stringify(result.outputSnapshot) : null,
          result?.error ?? null,
          result?.tokenUsage ? JSON.stringify(result.tokenUsage) : null,
          hasDurationMs,
          hasDurationMs ? result!.durationMs : null,
          hasCostMicroCents,
          hasCostMicroCents ? result!.costMicroCents : null,
          result?.model ?? null,
        ]
      );

      if (queryResult.rows.length === 0) return null;
      return mapRow(queryResult.rows[0]);
    });
  }
}
