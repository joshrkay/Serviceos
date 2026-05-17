/**
 * P2-030 — Postgres-backed shadow comparison store.
 *
 * Mirrors the pattern in PgAiRunRepository / PgDocumentRevisionRepository:
 *   - Extends PgBaseRepository for withTenant() RLS enforcement.
 *   - Parameterized queries everywhere — tenantId never inlined.
 *   - mapRow helper for row → domain object conversion.
 *   - Implements ShadowComparisonStore interface.
 *
 * PII redaction: both primary_response_text and shadow_response_text are
 * scrubbed through the existing scrubPii() helper (same module used by
 * TrainingAssetRedactionService) before INSERT. This strips emails, phone
 * numbers, and known-entity patterns deterministically. A future PR can
 * replace scrubPii with a more sophisticated redaction module without
 * touching the storage logic.
 */

import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { scrubPii } from '../training/scrub';
import type {
  ShadowComparisonResult,
  ShadowComparisonStore,
  ShadowComparisonListOptions,
  ShadowComparisonPage,
} from './shadow-comparison';
import type { LLMResponse } from '../gateway/gateway';

// ─── Row mapping ─────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): ShadowComparisonResult {
  const primaryLatencyMs = row.primary_latency_ms != null ? Number(row.primary_latency_ms) : 0;
  const shadowLatencyMs = row.shadow_latency_ms != null ? Number(row.shadow_latency_ms) : undefined;

  const primaryTokenUsage = (row.primary_token_usage as { input?: number; output?: number; total?: number } | null) ?? {
    input: 0,
    output: 0,
    total: 0,
  };

  const shadowTokenUsage = row.shadow_token_usage as
    | { input?: number; output?: number; total?: number }
    | null
    | undefined;

  const shadowText = row.shadow_response_text as string | null;
  const shadowModel = row.shadow_model as string;

  const primaryModel = (row.primary_model as string | null) ?? shadowModel;

  const primaryResponse: LLMResponse = {
    content: (row.primary_response_text as string | null) ?? '',
    model: primaryModel,
    provider: '',
    tokenUsage: {
      input: primaryTokenUsage.input ?? 0,
      output: primaryTokenUsage.output ?? 0,
      total: primaryTokenUsage.total ?? 0,
    },
    latencyMs: primaryLatencyMs,
  };

  const shadowResponse: LLMResponse | undefined =
    shadowText != null
      ? {
          content: shadowText,
          model: shadowModel,
          provider: '',
          tokenUsage: {
            input: shadowTokenUsage?.input ?? 0,
            output: shadowTokenUsage?.output ?? 0,
            total: shadowTokenUsage?.total ?? 0,
          },
          latencyMs: shadowLatencyMs ?? 0,
        }
      : undefined;

  const rawDivergence = row.divergence_score;
  const divergenceScore =
    rawDivergence != null ? Number(rawDivergence) : null;

  return {
    id: row.id as string,
    comparisonGroupId: (row.comparison_group_id as string | null) ?? (row.id as string),
    taskType: (row.task_type as string | null) ?? '',
    primaryResponse,
    shadowResponse,
    divergenceScore,
    sampledAt: new Date(row.created_at as string),
    tenantId: row.tenant_id as string,
    aiRunId: (row.ai_run_id as string | null) ?? undefined,
  };
}

// ─── Redaction helper ────────────────────────────────────────────────────────

function redactText(text: string | undefined | null): string | null {
  if (text == null) return null;
  const { scrubbed } = scrubPii(text, { failOnResidual: false });
  return scrubbed;
}

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Postgres-backed shadow comparison store (P2-030).
 *
 * Tenant isolation is enforced two ways:
 *   1. RLS via `app.current_tenant_id` (set by `withTenant`).
 *   2. Defense-in-depth `WHERE tenant_id = $N` in every query.
 */
export class PgShadowComparisonStore extends PgBaseRepository implements ShadowComparisonStore {
  constructor(pool: Pool) {
    super(pool);
  }

  async save(result: ShadowComparisonResult): Promise<ShadowComparisonResult> {
    // Determine tenantId — fall back to a system sentinel when not set
    // (in-process dev flows without tenant context).
    const tenantId = result.tenantId ?? '00000000-0000-0000-0000-000000000000';

    // PII redaction before storage.
    const primaryText = redactText(result.primaryResponse.content);
    const shadowText = redactText(result.shadowResponse?.content ?? null);

    const shadowModel =
      result.shadowResponse?.model ?? result.primaryResponse.model;

    return this.withTenant(tenantId, async (client) => {
      const qResult = await client.query(
        `INSERT INTO shadow_comparisons
           (id, tenant_id, ai_run_id, comparison_group_id, task_type,
            primary_model, shadow_model,
            primary_response_text, shadow_response_text,
            primary_latency_ms, shadow_latency_ms,
            primary_token_usage, shadow_token_usage,
            divergence_score, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          result.id,
          tenantId,
          result.aiRunId ?? null,
          result.comparisonGroupId ?? null,
          result.taskType ?? null,
          result.primaryResponse.model ?? null,
          shadowModel,
          primaryText,
          shadowText,
          result.primaryResponse.latencyMs ?? null,
          result.shadowResponse?.latencyMs ?? null,
          result.primaryResponse.tokenUsage
            ? JSON.stringify(result.primaryResponse.tokenUsage)
            : null,
          result.shadowResponse?.tokenUsage
            ? JSON.stringify(result.shadowResponse.tokenUsage)
            : null,
          null, // divergence_score — written by P2-020
          result.sampledAt,
        ]
      );

      if (qResult.rows.length === 0) {
        // Conflict on id — return the original (idempotent).
        return result;
      }
      return mapRow(qResult.rows[0]);
    });
  }

  /**
   * @internal TEST / MAINTENANCE USE ONLY — do NOT call from production code paths.
   *
   * Uses `withClient` without tenant context, so RLS is enforced by FORCE ROW LEVEL SECURITY
   * (which will error at the DB level when `app.current_tenant_id` is unset) rather than
   * silently scoping to the right tenant. In production, use `listForTenant` instead.
   */
  async findByGroup(groupId: string): Promise<ShadowComparisonResult[]> {
    console.warn(
      '[PgShadowComparisonStore] findByGroup() called without tenant context — ' +
        'this method is test/maintenance-only. Use listForTenant() in production.'
    );
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM shadow_comparisons
         WHERE comparison_group_id = $1
         ORDER BY created_at DESC`,
        [groupId]
      );
      return result.rows.map(mapRow);
    });
  }

  /**
   * @internal TEST / MAINTENANCE USE ONLY — do NOT call from production code paths.
   *
   * Uses `withClient` without tenant context. With FORCE ROW LEVEL SECURITY enabled,
   * this will throw at the DB level when `app.current_tenant_id` is unset, rather than
   * silently leaking cross-tenant data. In production, use `listForTenant` instead.
   */
  async getAll(): Promise<ShadowComparisonResult[]> {
    console.warn(
      '[PgShadowComparisonStore] getAll() called without tenant context — ' +
        'this method is test/maintenance-only. Use listForTenant() in production.'
    );
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM shadow_comparisons ORDER BY created_at DESC LIMIT 1000`
      );
      return result.rows.map(mapRow);
    });
  }

  async listForTenant(
    tenantId: string,
    opts: ShadowComparisonListOptions = {}
  ): Promise<ShadowComparisonPage> {
    const limit = Math.min(opts.limit ?? 50, 200);

    return this.withTenant(tenantId, async (client) => {
      const params: unknown[] = [tenantId];
      const conditions: string[] = ['tenant_id = $1'];

      if (opts.taskType) {
        params.push(opts.taskType);
        conditions.push(`task_type = $${params.length}`);
      }

      if (opts.cursor) {
        // cursor is an ISO timestamp — return rows strictly before it
        params.push(new Date(opts.cursor).toISOString());
        conditions.push(`created_at < $${params.length}`);
      }

      // Fetch limit+1 to detect if there is a next page.
      params.push(limit + 1);
      const limitParam = `$${params.length}`;

      const sql = `SELECT * FROM shadow_comparisons
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ${limitParam}`;

      const result = await client.query(sql, params);
      const rows = result.rows.map(mapRow);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore
        ? page[page.length - 1].sampledAt.toISOString()
        : null;

      return { comparisons: page, nextCursor };
    });
  }
}
