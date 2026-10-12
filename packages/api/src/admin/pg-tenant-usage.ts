/**
 * Postgres aggregation for the platform-admin tenant usage report.
 *
 * Tenancy: every query runs inside `withTenantTransaction(targetTenantId)`, so
 * RLS (`app.current_tenant_id` + the rls_app_runtime role when
 * RLS_RUNTIME_ROLE is on) scopes the reads to the TARGET tenant — the platform
 * admin never gets a BYPASSRLS sweep connection for a single-tenant read. When
 * the admin's own request-scoped tenant differs from the target,
 * withTenantTransaction opens its own connection with the target's context
 * (it only reuses the request client when the tenant ids match, in which case
 * that client already carries the same tenant context). Every query also
 * filters `tenant_id = $1` explicitly (defense in depth).
 *
 * Everything is aggregated in SQL (COUNT / SUM / GROUP BY); no rows are
 * loaded. Index support per window filter:
 *   - ai_runs (tenant_id, created_at)            idx_ai_runs_tenant_created_at (306)
 *   - call_usage_events (tenant_id, …)           UNIQUE (tenant_id, call_id) prefix;
 *                                                billable rows also idx_call_usage_events_period
 *   - ai_voice_usage_costs (tenant_id, occurred_at)  idx_ai_voice_usage_costs_period
 *   - audit_events (tenant_id, created_at DESC)  idx_audit_events_tenant_created_at
 *   - users (tenant_id)                          idx_users_tenant
 */
import type { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  TOP_EVENT_TYPES_LIMIT,
  toSafeInteger,
  type AiUsageFigures,
  type TenantUsageReport,
  type TenantUsageRepository,
  type UsageWindow,
} from './tenant-usage';

interface AiRow {
  task_type: string | null;
  is_total: boolean;
  runs: string;
  failed_runs: string;
  input_tokens: string;
  output_tokens: string;
  cost_micro_cents: string;
  unpriced_runs: string;
}

function mapAiFigures(row: AiRow | undefined): AiUsageFigures {
  return {
    runs: toSafeInteger(row?.runs),
    failedRuns: toSafeInteger(row?.failed_runs),
    inputTokens: toSafeInteger(row?.input_tokens),
    outputTokens: toSafeInteger(row?.output_tokens),
    costMicroCents: toSafeInteger(row?.cost_micro_cents),
    unpricedRuns: toSafeInteger(row?.unpriced_runs),
  };
}

/** Sum one numeric key of the ai_runs.token_usage JSONB ({input, output, total}). */
const tokenSum = (key: 'input' | 'output'): string =>
  `COALESCE(ROUND(SUM(CASE WHEN jsonb_typeof(token_usage->'${key}') = 'number'
                           THEN (token_usage->>'${key}')::numeric END)), 0)::bigint::text`;

export class PgTenantUsageRepository extends PgBaseRepository implements TenantUsageRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async getUsage(tenantId: string, window: UsageWindow): Promise<TenantUsageReport | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const tenant = await client.query<{
        id: string;
        name: string;
        plan_id: string | null;
        subscription_status: string | null;
        created_at: Date;
      }>(
        `SELECT id, name, plan_id, subscription_status, created_at
           FROM tenants WHERE id = $1`,
        [tenantId],
      );
      const t = tenant.rows[0];
      if (!t) return null;

      const params = [tenantId, window.from, window.to];
      const ai = await this.aiUsage(client, params);
      const voice = await this.voiceUsage(client, params);
      const activity = await this.activity(client, params);
      const users = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM users
          WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId],
      );

      return {
        tenant: {
          id: t.id,
          name: t.name,
          planId: t.plan_id,
          subscriptionStatus: t.subscription_status,
          createdAt: t.created_at.toISOString(),
        },
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        ai,
        voice,
        activity,
        users: { count: toSafeInteger(users.rows[0]?.n) },
      };
    });
  }

  private async aiUsage(
    client: PoolClient,
    params: unknown[],
  ): Promise<TenantUsageReport['ai']> {
    // GROUPING SETS gives the per-task rows and the grand total in one pass;
    // the total row is told apart by GROUPING() (task_type is NOT NULL, but
    // GROUPING is explicit rather than relying on that).
    const result = await client.query<AiRow>(
      `SELECT task_type,
              GROUPING(task_type) = 1 AS is_total,
              COUNT(*)::text AS runs,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS failed_runs,
              ${tokenSum('input')} AS input_tokens,
              ${tokenSum('output')} AS output_tokens,
              COALESCE(SUM(cost_micro_cents), 0)::text AS cost_micro_cents,
              COUNT(*) FILTER (WHERE cost_micro_cents IS NULL)::text AS unpriced_runs
         FROM ai_runs
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
        GROUP BY GROUPING SETS ((task_type), ())
        ORDER BY is_total DESC, COALESCE(SUM(cost_micro_cents), 0) DESC, COUNT(*) DESC, task_type`,
      params,
    );
    const total = result.rows.find((r) => r.is_total);
    return {
      totals: mapAiFigures(total),
      byTaskType: result.rows
        .filter((r) => !r.is_total)
        .map((r) => ({ taskType: r.task_type as string, ...mapAiFigures(r) })),
    };
  }

  private async voiceUsage(
    client: PoolClient,
    params: unknown[],
  ): Promise<TenantUsageReport['voice']> {
    const calls = await client.query<{
      calls: string;
      billable_calls: string;
      billable_seconds: string;
    }>(
      `SELECT COUNT(*)::text AS calls,
              COUNT(*) FILTER (WHERE billable)::text AS billable_calls,
              COALESCE(SUM(duration_seconds) FILTER (WHERE billable), 0)::text AS billable_seconds
         FROM call_usage_events
        WHERE tenant_id = $1 AND ended_at >= $2 AND ended_at < $3`,
      params,
    );
    const costs = await client.query<{
      provider: string | null;
      is_total: boolean;
      cost_micro_cents: string;
    }>(
      `SELECT provider,
              GROUPING(provider) = 1 AS is_total,
              COALESCE(SUM(provider_cost_micro_cents), 0)::text AS cost_micro_cents
         FROM ai_voice_usage_costs
        WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3
        GROUP BY GROUPING SETS ((provider), ())
        ORDER BY is_total DESC, provider`,
      params,
    );
    const billableSeconds = toSafeInteger(calls.rows[0]?.billable_seconds);
    return {
      calls: toSafeInteger(calls.rows[0]?.calls),
      billableCalls: toSafeInteger(calls.rows[0]?.billable_calls),
      billableSeconds,
      billableMinutes: Math.ceil(billableSeconds / 60),
      providerCostMicroCents: {
        total: toSafeInteger(costs.rows.find((r) => r.is_total)?.cost_micro_cents),
        byProvider: costs.rows
          .filter((r) => !r.is_total)
          .map((r) => ({
            provider: r.provider as string,
            costMicroCents: toSafeInteger(r.cost_micro_cents),
          })),
      },
    };
  }

  private async activity(
    client: PoolClient,
    params: unknown[],
  ): Promise<TenantUsageReport['activity']> {
    const count = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_events
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      params,
    );
    const last = await client.query<{ last_at: Date | null }>(
      `SELECT MAX(created_at) AS last_at FROM audit_events
        WHERE tenant_id = $1 AND created_at < $2`,
      [params[0], params[2]],
    );
    const top = await client.query<{ event_type: string; n: string }>(
      `SELECT event_type, COUNT(*)::text AS n FROM audit_events
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
        GROUP BY event_type
        ORDER BY COUNT(*) DESC, event_type
        LIMIT ${TOP_EVENT_TYPES_LIMIT}`,
      params,
    );
    const lastAt = last.rows[0]?.last_at ?? null;
    return {
      auditEventCount: toSafeInteger(count.rows[0]?.n),
      lastActivityAt: lastAt ? lastAt.toISOString() : null,
      topEventTypes: top.rows.map((r) => ({ eventType: r.event_type, count: toSafeInteger(r.n) })),
    };
  }
}
