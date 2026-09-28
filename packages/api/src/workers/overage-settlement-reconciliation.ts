/**
 * AI-minute overage settlement reconciliation (billing resilience, Part B).
 *
 * The invoice.created webhook settles each closed period via
 * CallUsageBillingService.settlePeriod, which is idempotent per
 * (tenant, period) — but a settlement can still strand money: the
 * invoice-item POST may exhaust its retries (Stripe down, bad customer
 * state), leaving call_usage_settlements stuck pending/failed, or a
 * period may have no settlement row at all (webhook missed/dropped).
 *
 * This periodic sweep repairs both, mirroring the trial-reminder sweep
 * shape (hourly tick from app.ts, leader-gated, bounded per-tick):
 *
 *   1. Stale-retry — settlements still pending/failed after STALE_AFTER_MS
 *      are re-driven through billing.retrySettlement, which reuses the
 *      originally computed charge and re-POSTs the invoice item with
 *      retry-with-backoff. The grace delay gives the webhook's own retries
 *      (throw → 500 → Stripe redelivery) first crack.
 *
 *   2. Gap backfill — for each subscribed tenant with a mirrored billing
 *      period, the metered AI usage of the previous closed period is
 *      compared against billed invoice items (settlement rows overlapping
 *      that window). When metered usage prices to a positive charge and no
 *      settlement row covers the window, the sweep calls settlePeriod to
 *      create + bill it, attaching the item to the next open invoice.
 *
 * Both paths are idempotent: retrySettlement returns completed rows as-is,
 * and settlePeriod's ensurePending reuses the originally computed charge.
 * The sweep never rewrites money — it only completes settlements that
 * were priced but never billed.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { CallUsageBillingService, CallUsageSettlementRow } from '../billing/call-usage-billing';
import type { PgCallUsageRepository } from '../billing/call-usage-events';
import type { OverageCapStore } from '../billing/overage-cap';
import { priceMinuteUsage, type CallPlanId } from '../billing/call-usage-pricing';

export interface OverageSettlementReconciliationDeps {
  pool: Pool | null;
  logger: Logger;
  /** Null in dev/test without Stripe configured → the sweep no-ops. */
  billing: CallUsageBillingService | null;
  callUsage: Pick<PgCallUsageRepository, 'sumBillableSeconds'>;
  overageCaps: OverageCapStore;
  /** Maps a plan to its configured Stripe price id; null skips the tenant. */
  priceIdForPlan: (planId: CallPlanId) => string | null;
  now?: () => Date;
}

export interface OverageSettlementReconciliationResult {
  staleChecked: number;
  staleRetried: number;
  staleCompleted: number;
  staleStillFailing: number;
  gapsChecked: number;
  gapsBackfilled: number;
  failed: number;
}

/** Settlements stuck this long are re-driven; fresher ones may still be
 * riding the webhook's own retry/backoff. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

const BATCH_LIMIT = 200;

interface StaleSettlementRow {
  id: string;
  tenant_id: string;
  status: 'pending' | 'failed';
  billable_minutes: number;
  overage_minutes: number;
  customer_charge_cents: number;
  stripe_invoice_item_id: string | null;
}

const STALE_SQL = `
  SELECT s.id, s.tenant_id, s.status, s.billable_minutes, s.overage_minutes,
         s.customer_charge_cents, s.stripe_invoice_item_id
    FROM call_usage_settlements s
    JOIN tenants t ON t.id = s.tenant_id
   WHERE s.status IN ('pending', 'failed')
     AND s.updated_at < $1
   ORDER BY s.updated_at ASC
   LIMIT ${BATCH_LIMIT}
`;

interface GapTenantRow {
  id: string;
  plan_id: string;
  current_period_start: Date;
  current_period_end: Date;
}

const GAP_TENANTS_SQL = `
  SELECT id, plan_id, current_period_start, current_period_end
    FROM tenants
   WHERE subscription_status IN ('active', 'past_due')
     AND plan_id IN ('starter', 'growth')
     AND current_period_start IS NOT NULL
     AND current_period_end IS NOT NULL
     AND stripe_customer_id IS NOT NULL
   ORDER BY current_period_end ASC
   LIMIT ${BATCH_LIMIT}
`;

const COVERING_SETTLEMENT_SQL = `
  SELECT id, status
    FROM call_usage_settlements
   WHERE tenant_id = $1
     AND period_start < $3
     AND period_end > $2
   LIMIT 1
`;

function toSettlementRow(row: StaleSettlementRow): CallUsageSettlementRow {
  return {
    id: row.id,
    status: row.status,
    billableMinutes: Number(row.billable_minutes),
    overageMinutes: Number(row.overage_minutes),
    customerChargeCents: Number(row.customer_charge_cents),
    stripeInvoiceItemId: row.stripe_invoice_item_id ?? null,
  };
}

export async function runOverageSettlementReconciliation(
  deps: OverageSettlementReconciliationDeps,
): Promise<OverageSettlementReconciliationResult> {
  const result: OverageSettlementReconciliationResult = {
    staleChecked: 0,
    staleRetried: 0,
    staleCompleted: 0,
    staleStillFailing: 0,
    gapsChecked: 0,
    gapsBackfilled: 0,
    failed: 0,
  };
  if (!deps.pool || !deps.billing) return result;

  const now = deps.now ?? (() => new Date());
  const asOf = now();

  // ── Path 1: re-drive stale pending/failed settlements ──
  let staleRows: StaleSettlementRow[];
  try {
    const res = await deps.pool.query<StaleSettlementRow>(STALE_SQL, [
      new Date(asOf.getTime() - STALE_AFTER_MS),
    ]);
    staleRows = res.rows;
  } catch (err) {
    deps.logger.error('Overage reconciliation: stale-settlement query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
  result.staleChecked = staleRows.length;

  for (const row of staleRows) {
    try {
      result.staleRetried++;
      const outcome = await deps.billing.retrySettlement({
        tenantId: row.tenant_id,
        settlement: toSettlementRow(row),
      });
      if (outcome.invoiceItemId !== null || outcome.alreadyCompleted) {
        result.staleCompleted++;
      } else {
        result.staleStillFailing++;
      }
    } catch (err) {
      // retrySettlement throws only after marking failed + alerting + DLQ;
      // count it and move on — the next tick tries again.
      result.staleStillFailing++;
      deps.logger.warn('Overage reconciliation: stale settlement still failing', {
        tenantId: row.tenant_id,
        settlementId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Path 2: backfill gap periods (metered usage, never billed) ──
  let tenants: GapTenantRow[];
  try {
    const res = await deps.pool.query<GapTenantRow>(GAP_TENANTS_SQL);
    tenants = res.rows;
  } catch (err) {
    deps.logger.error('Overage reconciliation: gap-tenant query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    result.failed++;
    return result;
  }

  for (const tenant of tenants) {
    try {
      const periodEnd = new Date(tenant.current_period_end);
      const periodStart = new Date(tenant.current_period_start);
      const durationMs = periodEnd.getTime() - periodStart.getTime();
      if (!(durationMs > 0)) {
        result.failed++;
        continue;
      }
      // The last closed period: one full billing-period length back from
      // the current period's start.
      const prevStart = new Date(periodStart.getTime() - durationMs);
      const prevEnd = periodStart;
      if (prevStart.getTime() >= asOf.getTime()) continue; // not closed yet

      result.gapsChecked++;
      const covered = await deps.pool.query(COVERING_SETTLEMENT_SQL, [
        tenant.id,
        prevStart,
        prevEnd,
      ]);
      if ((covered.rowCount ?? 0) > 0) continue;

      const planId = tenant.plan_id as CallPlanId;
      const billableSeconds = await deps.callUsage.sumBillableSeconds(
        tenant.id,
        prevStart,
        prevEnd,
      );
      const price = priceMinuteUsage({
        planId,
        billableSeconds,
        overageCapCents: await deps.overageCaps.get(tenant.id),
      });
      if (price.customerChargeCents <= 0) continue; // within bundle — nothing to bill

      const subscriptionPriceId = deps.priceIdForPlan(planId);
      if (!subscriptionPriceId) {
        deps.logger.warn('Overage reconciliation: no price id for plan, skipping backfill', {
          tenantId: tenant.id,
          planId,
        });
        continue;
      }
      // No stripeInvoiceId: the original invoice is long gone; the item
      // attaches to the next open invoice.
      await deps.billing.settlePeriod({
        tenantId: tenant.id,
        periodStart: prevStart,
        periodEnd: prevEnd,
        subscriptionPriceId,
      });
      result.gapsBackfilled++;
      deps.logger.info('Overage reconciliation: backfilled gap period', {
        tenantId: tenant.id,
        periodStart: prevStart.toISOString(),
        periodEnd: prevEnd.toISOString(),
        chargeCents: price.customerChargeCents,
      });
    } catch (err) {
      result.failed++;
      deps.logger.warn('Overage reconciliation: gap backfill failed', {
        tenantId: tenant.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
