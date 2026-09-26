/**
 * AI-minute usage summary for the owner's settings page: this billing
 * period's minutes against the plan bundle and the projected overage after
 * their cap, or — during the trial — minutes against the trial allowance.
 */
import type { Pool } from 'pg';
import { PgCallUsageRepository } from './call-usage-events';
import { PgOverageCapStore } from './overage-cap';
import { readTenantBillingState } from './tenant-billing-state';
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
    const tenant = await readTenantBillingState(this.pool, tenantId);
    const planId = tenant?.planId ?? 'starter';

    if (tenant?.status === 'trialing') {
      const seconds = await this.ledger.sumTrialBillableSeconds(tenantId);
      return {
        kind: 'trial',
        planId,
        usedMinutes: Math.ceil(seconds / 60),
        includedMinutes: TRIAL_MINUTE_LIMITS.TRIAL_TOTAL_SECONDS / 60,
      };
    }
    if (!tenant?.period) return { kind: 'none' };

    const { start: periodStart, end: periodEnd } = tenant.period;
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
