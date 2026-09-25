import { describe, expect, it } from "vitest";
import { priceMinuteUsage } from "../../src/billing/call-usage-pricing";

describe("AI answering minute pricing", () => {
  it("charges nothing for Starter's 20 included minutes", () => {
    expect(priceMinuteUsage({ planId: "starter", billableSeconds: 1_200 })).toEqual({
      includedMinutes: 20,
      billableMinutes: 20,
      overageMinutes: 0,
      customerChargeCents: 0,
    });
  });

  it("rounds the period up once: 1,201 seconds is 21 minutes, one over at $1.25", () => {
    expect(priceMinuteUsage({ planId: "starter", billableSeconds: 1_201 })).toEqual({
      includedMinutes: 20,
      billableMinutes: 21,
      overageMinutes: 1,
      customerChargeCents: 125,
    });
  });

  it("includes 60 minutes on Growth and charges $1.25 for minute 61", () => {
    expect(priceMinuteUsage({ planId: "growth", billableSeconds: 3_600 }).customerChargeCents).toBe(0);
    expect(priceMinuteUsage({ planId: "growth", billableSeconds: 3_660 })).toEqual({
      includedMinutes: 60,
      billableMinutes: 61,
      overageMinutes: 1,
      customerChargeCents: 125,
    });
  });

  it("caps overage at the plan price by default", () => {
    // 200 minutes on Starter: 180 over x $1.25 = $225, capped at $79.
    expect(priceMinuteUsage({ planId: "starter", billableSeconds: 12_000 })).toEqual({
      includedMinutes: 20,
      billableMinutes: 200,
      overageMinutes: 180,
      customerChargeCents: 7_900,
    });
  });

  it("honours an owner-raised cap, or no cap at all", () => {
    const starter200Min = { planId: "starter" as const, billableSeconds: 12_000 };
    expect(priceMinuteUsage({ ...starter200Min, overageCapCents: 20_000 }).customerChargeCents).toBe(20_000);
    expect(priceMinuteUsage({ ...starter200Min, overageCapCents: 30_000 }).customerChargeCents).toBe(22_500);
    expect(priceMinuteUsage({ ...starter200Min, overageCapCents: null }).customerChargeCents).toBe(22_500);
  });

  it("rejects seconds and caps that are not non-negative integers", () => {
    expect(() => priceMinuteUsage({ planId: "starter", billableSeconds: -1 })).toThrow(RangeError);
    expect(() => priceMinuteUsage({ planId: "starter", billableSeconds: 1.5 })).toThrow(RangeError);
    expect(() =>
      priceMinuteUsage({ planId: "starter", billableSeconds: 60, overageCapCents: -100 }),
    ).toThrow(RangeError);
  });
});
