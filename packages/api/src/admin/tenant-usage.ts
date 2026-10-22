/**
 * Platform-admin tenant usage report — the read model behind
 * GET /api/admin/tenants/:tenantId/usage.
 *
 * Operators need one tenant's AI / voice / activity footprint over a window
 * without a SQL console. This module owns the contract (report shape, the
 * query-window rules) and the repository seam; the Postgres aggregation lives
 * in ./pg-tenant-usage.ts.
 *
 * Money is integer micro-cents (1 cent = 1,000,000 micro-cents, matching
 * ai_runs.cost_micro_cents / ai_voice_usage_costs.provider_cost_micro_cents) —
 * never floats. Timestamps are ISO-8601 UTC strings on the wire.
 */
import { z } from 'zod';
import { ValidationError } from '../shared/errors';

/** Window used when the caller omits `from`: the trailing 30 days. */
export const DEFAULT_USAGE_WINDOW_DAYS = 30;
/** Widest window an operator may request (a leap year plus slack). */
export const MAX_USAGE_WINDOW_DAYS = 366;
/** How many event types `activity.topEventTypes` reports. */
export const TOP_EVENT_TYPES_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

const isoInstant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

export const tenantUsageQuerySchema = z.object({
  from: isoInstant.optional(),
  to: isoInstant.optional(),
});

export interface UsageWindow {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

/**
 * Resolve and validate the `?from=&to=` query. Defaults: `to` = now,
 * `from` = `to` − 30 days. Rejects from >= to and windows wider than
 * MAX_USAGE_WINDOW_DAYS with a ValidationError (→ 400).
 */
export function resolveUsageWindow(query: unknown, now: Date): UsageWindow {
  const parsed = tenantUsageQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid usage window', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date(now.getTime());
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - DEFAULT_USAGE_WINDOW_DAYS * DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw new ValidationError('`from` must be before `to`');
  }
  if (to.getTime() - from.getTime() > MAX_USAGE_WINDOW_DAYS * DAY_MS) {
    throw new ValidationError(`Usage window may not exceed ${MAX_USAGE_WINDOW_DAYS} days`);
  }
  return { from, to };
}

/**
 * Coerce a Postgres aggregate (COUNT/SUM come back as text for BIGINT/NUMERIC)
 * to a JS integer, refusing anything that would lose precision. NULL → 0.
 */
export function toSafeInteger(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Aggregate is not a safe integer: ${String(value)}`);
  }
  return n;
}

export interface AiUsageFigures {
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of priced runs only — see `unpricedRuns`. */
  costMicroCents: number;
  /** Runs with a NULL cost (unpriced model): costMicroCents is a lower bound when > 0. */
  unpricedRuns: number;
}

export interface TenantUsageReport {
  tenant: {
    id: string;
    name: string;
    planId: string | null;
    subscriptionStatus: string | null;
    createdAt: string;
  };
  window: { from: string; to: string };
  ai: {
    totals: AiUsageFigures;
    byTaskType: Array<{ taskType: string } & AiUsageFigures>;
  };
  voice: {
    /** call_usage_events rows whose call ended inside the window. */
    calls: number;
    billableCalls: number;
    billableSeconds: number;
    /** ceil(billableSeconds / 60) — the same rounding priceMinuteUsage bills. */
    billableMinutes: number;
    providerCostMicroCents: {
      total: number;
      byProvider: Array<{ provider: string; costMicroCents: number }>;
    };
  };
  activity: {
    /** audit_events rows created inside the window. */
    auditEventCount: number;
    /** Newest audit event before `window.to` (not limited by `window.from`); null if none. */
    lastActivityAt: string | null;
    topEventTypes: Array<{ eventType: string; count: number }>;
  };
  users: {
    /** Non-deleted users rows for the tenant. */
    count: number;
  };
}

export interface TenantUsageRepository {
  /** null when no tenant with that id exists. */
  getUsage(tenantId: string, window: UsageWindow): Promise<TenantUsageReport | null>;
}
