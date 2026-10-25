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
 *
 * Retention: rows are deleted once older than SHADOW_COMPARISON_RETENTION_DAYS
 * (default 365) by the hourly, leader-gated sweep in
 * workers/shadow-comparison-retention-worker.ts, for every tenant and the
 * placeholder bucket below. Scrubbed reply text is still caller-derived, so it
 * is not kept indefinitely.
 *
 * `ai_run_id` is always NULL today. ShadowComparisonGateway reads it from
 * `request.metadata.aiRunId`, and no caller sets that: the ai_runs id exists
 * only inside LLMGateway.complete, which hands the request to the provider
 * stack (quota → failover → retry/breaker → shadow) without it. Linking it
 * means threading a per-call id through every LLM request, and the shadow
 * save runs on its own connection: a run row written on a still-open tenant
 * transaction (the in-transaction guard only logs outside tests) is not
 * visible there, so the INSERT would fail the FK and the sample would be
 * dropped. It is not wired; the column stays NULL until a reader needs it.
 */

import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { isValidTenantId } from '../../db/schema';
import { scrubPii } from '../training/scrub';
import type {
  ShadowComparisonResult,
  ShadowComparisonStore,
  ShadowComparisonListOptions,
  ShadowComparisonPage,
} from './shadow-comparison';
import { SYSTEM_TENANT_ID, type LLMResponse } from '../gateway/gateway';

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

// ─── Tenant mapping ──────────────────────────────────────────────────────────

/**
 * The tenant a comparison is stored and read under. Not every LLM call has a
 * tenant UUID: platform calls (the readiness probe, the call-quality judges)
 * run as SYSTEM_TENANT_ID = 'system', and in-process dev flows may set none.
 * `withTenant` refuses anything that is not a UUID, so those comparisons are
 * filed under one all-zero placeholder tenant instead, so a sample never
 * fails on its tenant id. Reads are stricter: only SYSTEM_TENANT_ID maps to
 * the placeholder, so `listForTenant('system')` reads back what a 'system'
 * call stored, and any other non-UUID is refused rather than opening the
 * bucket that holds cross-tenant platform calls. The retention sweep deletes
 * this bucket's expired rows like any tenant's, but writes no audit event for
 * them: the placeholder has no tenants row for audit_events to reference.
 */
export const PLACEHOLDER_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function storageTenantId(tenantId: string | undefined): string {
  return tenantId && isValidTenantId(tenantId) ? tenantId : PLACEHOLDER_TENANT_ID;
}

function readTenantId(tenantId: string): string {
  return tenantId === SYSTEM_TENANT_ID ? PLACEHOLDER_TENANT_ID : tenantId;
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
    const tenantId = storageTenantId(result.tenantId);

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

  async listForTenant(
    tenantId: string,
    opts: ShadowComparisonListOptions = {}
  ): Promise<ShadowComparisonPage> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const storedUnder = readTenantId(tenantId);

    return this.withTenant(storedUnder, async (client) => {
      const params: unknown[] = [storedUnder];
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
