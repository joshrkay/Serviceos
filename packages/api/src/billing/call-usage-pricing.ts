/**
 * Customer-facing per-call usage policy.
 *
 * Each plan includes a bundle of billable answered calls per billing period;
 * calls beyond the bundle are charged a flat integer-cent amount each.
 */
export type CallPlanId = "starter" | "growth";

export interface CallPlanUsagePolicy {
  monthlyPriceCents: number;
  includedCalls: number;
  overageCentsPerCall: number;
}

export const CALL_PLAN_USAGE: Record<CallPlanId, CallPlanUsagePolicy> = {
  starter: { monthlyPriceCents: 7_900, includedCalls: 50, overageCentsPerCall: 150 },
  growth: { monthlyPriceCents: 19_900, includedCalls: 150, overageCentsPerCall: 125 },
};

export interface PriceCallUsageInput {
  planId: CallPlanId;
  /** Billable calls for one tenant and billing period. */
  billableCalls: number;
  /**
   * Tenant overage ceiling for the period. Omitted: one plan price.
   * null: no ceiling.
   */
  overageCapCents?: number | null;
}

export interface CallUsagePrice {
  includedCalls: number;
  billableCalls: number;
  overageCalls: number;
  customerChargeCents: number;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function priceCallUsage(input: PriceCallUsageInput): CallUsagePrice {
  const { monthlyPriceCents, includedCalls, overageCentsPerCall } =
    CALL_PLAN_USAGE[input.planId];
  const billableCalls = nonNegativeInteger(input.billableCalls, "billableCalls");
  const overageCalls = Math.max(0, billableCalls - includedCalls);
  const uncappedChargeCents = overageCalls * overageCentsPerCall;
  const capCents =
    input.overageCapCents === undefined
      ? monthlyPriceCents
      : input.overageCapCents === null
        ? null
        : nonNegativeInteger(input.overageCapCents, "overageCapCents");
  return {
    includedCalls,
    billableCalls,
    overageCalls,
    customerChargeCents:
      capCents === null
        ? uncappedChargeCents
        : Math.min(uncappedChargeCents, capCents),
  };
}
