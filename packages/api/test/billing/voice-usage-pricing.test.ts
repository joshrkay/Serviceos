import { describe, expect, it } from "vitest";
import {
  AI_VOICE_INCLUDED_SECONDS,
  AI_VOICE_MARKUP_BPS,
  priceAiVoiceUsage,
} from "../../src/billing/voice-usage-pricing";

describe("AI voice usage pricing", () => {
  it("includes the first 30 minutes without an overage charge", () => {
    expect(AI_VOICE_INCLUDED_SECONDS).toBe(30 * 60);
    expect(
      priceAiVoiceUsage({
        usageSeconds: 30 * 60,
        providerCostMicroCents: 4_000_000,
      }),
    ).toEqual({
      includedSeconds: 30 * 60,
      billableSeconds: 0,
      billableProviderCostMicroCents: 0,
      customerChargeMicroCents: 0,
      customerChargeCents: 0,
    });
  });

  it("charges actual overage cost plus a 30 percent markup", () => {
    expect(AI_VOICE_MARKUP_BPS).toBe(3_000);
    expect(
      priceAiVoiceUsage({
        usageSeconds: 40 * 60,
        // $4 total cost spread evenly over 40 minutes. The final 10 minutes
        // carry $1 of provider cost, then the customer pays $1.30.
        providerCostMicroCents: 400_000_000,
      }),
    ).toEqual({
      includedSeconds: 30 * 60,
      billableSeconds: 10 * 60,
      billableProviderCostMicroCents: 100_000_000,
      customerChargeMicroCents: 130_000_000,
      customerChargeCents: 130,
    });
  });

  it("rounds only the final monthly customer charge to whole cents", () => {
    expect(
      priceAiVoiceUsage({
        usageSeconds: 31 * 60,
        providerCostMicroCents: 31_000_000,
      }).customerChargeCents,
    ).toBe(1);
  });
});
