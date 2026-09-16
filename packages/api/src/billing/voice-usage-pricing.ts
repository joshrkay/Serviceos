/**
 * Customer-facing AI voice usage policy.
 *
 * Provider costs are retained in micro-cents (1 cent = 1,000,000
 * micro-cents) so sub-cent LLM, speech, and telephony charges do not vanish.
 * The customer receives 30 minutes per billing period; only provider cost
 * attributable to seconds beyond that allowance is marked up by 30%.
 */
export const AI_VOICE_INCLUDED_MINUTES = 30;
export const AI_VOICE_INCLUDED_SECONDS = AI_VOICE_INCLUDED_MINUTES * 60;
export const AI_VOICE_MARKUP_BPS = 3_000;

const MICRO_CENTS_PER_CENT = 1_000_000;
const BPS_DENOMINATOR = 10_000;

export interface PriceAiVoiceUsageInput {
  /** Aggregate AI voice usage for one tenant and billing period. */
  usageSeconds: number;
  /** Aggregate actual provider cost for that same usage and period. */
  providerCostMicroCents: number;
}

export interface AiVoiceUsagePrice {
  includedSeconds: number;
  billableSeconds: number;
  billableProviderCostMicroCents: number;
  customerChargeMicroCents: number;
  /** Stripe-facing amount. Rounding occurs once, after aggregation + markup. */
  customerChargeCents: number;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function roundedRatio(numerator: bigint, denominator: bigint): number {
  const rounded = (numerator + denominator / 2n) / denominator;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      "calculated voice usage charge exceeds safe integer range",
    );
  }
  return value;
}

export function priceAiVoiceUsage(
  input: PriceAiVoiceUsageInput,
): AiVoiceUsagePrice {
  const usageSeconds = nonNegativeInteger(input.usageSeconds, "usageSeconds");
  const providerCostMicroCents = nonNegativeInteger(
    input.providerCostMicroCents,
    "providerCostMicroCents",
  );
  const includedSeconds = Math.min(usageSeconds, AI_VOICE_INCLUDED_SECONDS);
  const billableSeconds = usageSeconds - includedSeconds;

  if (
    usageSeconds === 0 ||
    billableSeconds === 0 ||
    providerCostMicroCents === 0
  ) {
    return {
      includedSeconds,
      billableSeconds,
      billableProviderCostMicroCents: 0,
      customerChargeMicroCents: 0,
      customerChargeCents: 0,
    };
  }

  // Attribute cost proportionally because providers bill the whole call while
  // the included allowance can end part-way through a call/billing aggregate.
  const billableProviderCostMicroCents = roundedRatio(
    BigInt(providerCostMicroCents) * BigInt(billableSeconds),
    BigInt(usageSeconds),
  );
  const customerChargeMicroCents = roundedRatio(
    BigInt(billableProviderCostMicroCents) *
      BigInt(BPS_DENOMINATOR + AI_VOICE_MARKUP_BPS),
    BigInt(BPS_DENOMINATOR),
  );

  return {
    includedSeconds,
    billableSeconds,
    billableProviderCostMicroCents,
    customerChargeMicroCents,
    customerChargeCents: Math.round(
      customerChargeMicroCents / MICRO_CENTS_PER_CENT,
    ),
  };
}
