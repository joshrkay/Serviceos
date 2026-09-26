/**
 * Customer-facing AI answering policy: each plan includes a bundle of AI
 * answering minutes per billing period; minutes beyond it are charged a flat
 * integer-cent rate. Seconds are summed for the period and rounded up to a
 * whole minute once.
 */
export type CallPlanId = "starter" | "growth";

export interface PriceMinuteUsageInput {
  planId: CallPlanId;
  /** Billable AI answering seconds for one tenant and billing period. */
  billableSeconds: number;
  /**
   * Tenant overage ceiling for the period. Omitted: one plan price.
   * null: no ceiling.
   */
  overageCapCents?: number | null;
}

export interface MinuteUsagePrice {
  includedMinutes: number;
  billableMinutes: number;
  overageMinutes: number;
  customerChargeCents: number;
}

export const OVERAGE_CENTS_PER_MINUTE = 125;

export interface CallPlanUsagePolicy {
  monthlyPriceCents: number;
  includedMinutes: number;
  /** Every login counts, technicians included, plus pending invitations. */
  includedUsers: number;
}

export const CALL_PLAN_USAGE: Record<CallPlanId, CallPlanUsagePolicy> = {
  starter: { monthlyPriceCents: 7_900, includedMinutes: 20, includedUsers: 2 },
  growth: { monthlyPriceCents: 19_900, includedMinutes: 60, includedUsers: 5 },
};

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function priceMinuteUsage(input: PriceMinuteUsageInput): MinuteUsagePrice {
  const { includedMinutes, monthlyPriceCents } = CALL_PLAN_USAGE[input.planId];
  const billableSeconds = nonNegativeInteger(input.billableSeconds, "billableSeconds");
  const billableMinutes = Math.ceil(billableSeconds / 60);
  const overageMinutes = Math.max(0, billableMinutes - includedMinutes);
  const uncappedChargeCents = overageMinutes * OVERAGE_CENTS_PER_MINUTE;
  const capCents =
    input.overageCapCents === undefined
      ? monthlyPriceCents
      : input.overageCapCents === null
        ? null
        : nonNegativeInteger(input.overageCapCents, "overageCapCents");
  return {
    includedMinutes,
    billableMinutes,
    overageMinutes,
    customerChargeCents:
      capCents === null
        ? uncappedChargeCents
        : Math.min(uncappedChargeCents, capCents),
  };
}

/**
 * The one rule for "this period's AI-minute overage has reached the owner's
 * cap" — shared by the voice gate (calls start ringing the owner), usage
 * alerts and the usage summary. Reached when the included minutes are used
 * up and the uncapped overage charge is at or past the cap; a null cap is
 * never reached, and a $0 cap is reached exactly when the bundle runs out.
 */
export function isOverageCapReached(input: PriceMinuteUsageInput): boolean {
  if (input.overageCapCents === null) return false;
  const { billableMinutes, includedMinutes, customerChargeCents } = priceMinuteUsage({
    planId: input.planId,
    billableSeconds: input.billableSeconds,
    overageCapCents: null,
  });
  const capCents =
    input.overageCapCents === undefined
      ? CALL_PLAN_USAGE[input.planId].monthlyPriceCents
      : nonNegativeInteger(input.overageCapCents, "overageCapCents");
  return billableMinutes >= includedMinutes && customerChargeCents >= capCents;
}
