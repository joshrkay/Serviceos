/**
 * AI-minute usage summary for the owner's settings page: this billing
 * period's minutes against the plan bundle and the projected overage after
 * their cap, or — during the trial — minutes against the trial allowance.
 */
import type { Pool } from 'pg';
import { PgCallUsageRepository } from './call-usage-events';
import { PgOverageCapStore } from './overage-cap';
import {
  CALL_PLAN_USAGE,
  isOverageCapReached,
  OVERAGE_CENTS_PER_MINUTE,
  priceMinuteUsage,
  type CallPlanId,
} from './call-usage-pricing';
import { TRIAL_MINUTE_LIMITS } from '../voice/trial-limits';

export type AiUsage =
  | {
      kind: 'trial';
      planId: CallPlanId;
      usedMinutes: number;
      includedMinutes: number;
    }
  | {
      kind: 'period';
      planId: CallPlanId;
      periodStart: Date;
      periodEnd: Date;
      usedMinutes: number;
      includedMinutes: number;
      overageMinutes: number;
      overageCentsPerMinute: number;
      /** What this period's overage would be charged now, after the cap. */
      projectedChargeCents: number;
      /** The effective cap in cents; null when the owner removed it. */
      capCents: number | null;
      /** Overage has reached the cap: calls now ring the owner (isOverageCapReached). */
      capReached: boolean;
    }
  /** No billing period mirrored yet (before the first subscription webhook). */
  | { kind: 'none' };

export class AiUsageReader {
  private readonly ledger: PgCallUsageRepository;
  private readonly caps: PgOverageCapStore;

  constructor(private readonly pool: Pool) {
    this.ledger = new PgCallUsageRepository(pool);
    this.caps = new PgOverageCapStore(pool);
  }

  async getUsage(tenantId: string): Promise<AiUsage> {
    const res = await this.pool.query<{
      subscription_status: string | null;
      plan_id: CallPlanId | null;
      current_period_start: Date | null;
      current_period_end: Date | null;
    }>(
      `SELECT subscription_status, plan_id, current_period_start, current_period_end
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const tenant = res.rows[0];
    const planId = tenant?.plan_id ?? 'starter';

    if (tenant?.subscription_status === 'trialing') {
      const seconds = await this.ledger.sumBillableSeconds(tenantId, new Date(0), new Date(8.64e15));
      return {
        kind: 'trial',
        planId,
        usedMinutes: Math.ceil(seconds / 60),
        includedMinutes: TRIAL_MINUTE_LIMITS.TRIAL_TOTAL_SECONDS / 60,
      };
    }
    if (!tenant?.current_period_start || !tenant.current_period_end) return { kind: 'none' };

    const periodStart = new Date(tenant.current_period_start);
    const periodEnd = new Date(tenant.current_period_end);
    const cap = await this.caps.get(tenantId);
    const billableSeconds = await this.ledger.sumBillableSeconds(tenantId, periodStart, periodEnd);
    const price = priceMinuteUsage({ planId, billableSeconds, overageCapCents: cap });
    return {
      kind: 'period',
      planId,
      periodStart,
      periodEnd,
      usedMinutes: price.billableMinutes,
      includedMinutes: price.includedMinutes,
      overageMinutes: price.overageMinutes,
      overageCentsPerMinute: OVERAGE_CENTS_PER_MINUTE,
      projectedChargeCents: price.customerChargeCents,
      capCents: cap === undefined ? CALL_PLAN_USAGE[planId].monthlyPriceCents : cap,
      capReached: isOverageCapReached({ planId, billableSeconds, overageCapCents: cap }),
    };
  }
}
