import { describe, expect, it } from "vitest";
import { isOverageCapReached, priceMinuteUsage } from "../../src/billing/call-usage-pricing";

describe("AI answering minute pricing", () => {
  it("charges nothing for Starter's 60 included minutes", () => {
    expect(priceMinuteUsage({ planId: "starter", billableSeconds: 3_600 })).toEqual({
      includedMinutes: 60,
      billableMinutes: 60,
      overageMinutes: 0,
      customerChargeCents: 0,
    });
  });

  it("rounds the period up once: 3,601 seconds is 61 minutes, one over at $1.25", () => {
    expect(priceMinuteUsage({ planId: "starter", billableSeconds: 3_601 })).toEqual({
      includedMinutes: 60,
      billableMinutes: 61,
      overageMinutes: 1,
      customerChargeCents: 125,
    });
  });

  it("includes 200 minutes on Growth and charges $1.25 for minute 201", () => {
    expect(priceMinuteUsage({ planId: "growth", billableSeconds: 12_000 }).customerChargeCents).toBe(0);
    expect(priceMinuteUsage({ planId: "growth", billableSeconds: 12_060 })).toEqual({
      includedMinutes: 200,
      billableMinutes: 201,
      overageMinutes: 1,
      customerChargeCents: 125,
    });
  });

  it("caps overage at the plan price by default", () => {
    // 200 minutes on Starter: 140 over x $1.25 = $175, capped at $79.
    expect(priceMinuteUsage({ planId: "starter", billableSeconds: 12_000 })).toEqual({
      includedMinutes: 60,
      billableMinutes: 200,
      overageMinutes: 140,
      customerChargeCents: 7_900,
    });
  });

  it("honours an owner-raised cap, or no cap at all", () => {
    // 300 minutes on Starter: 240 over x $1.25 = $300.
    const starter300Min = { planId: "starter" as const, billableSeconds: 18_000 };
    expect(priceMinuteUsage({ ...starter300Min, overageCapCents: 20_000 }).customerChargeCents).toBe(20_000);
    expect(priceMinuteUsage({ ...starter300Min, overageCapCents: 40_000 }).customerChargeCents).toBe(30_000);
    expect(priceMinuteUsage({ ...starter300Min, overageCapCents: null }).customerChargeCents).toBe(30_000);
  });

  it("rejects seconds and caps that are not non-negative integers", () => {
    expect(() => priceMinuteUsage({ planId: "starter", billableSeconds: -1 })).toThrow(RangeError);
    expect(() => priceMinuteUsage({ planId: "starter", billableSeconds: 1.5 })).toThrow(RangeError);
    expect(() =>
      priceMinuteUsage({ planId: "starter", billableSeconds: 60, overageCapCents: -100 }),
    ).toThrow(RangeError);
  });
});

describe("overage cap reached", () => {
  const starter = (minutes: number, overageCapCents?: number | null) =>
    isOverageCapReached({ planId: "starter", billableSeconds: minutes * 60, overageCapCents });

  it("is reached once overage would pass the default $79 Starter cap", () => {
    expect(starter(123)).toBe(false); // 63 over x $1.25 = $78.75
    expect(starter(124)).toBe(true); // 64 over x $1.25 = $80.00
  });

  it("honours a raised cap and is never reached without one", () => {
    expect(starter(210, 20_000)).toBe(false); // 150 over = $187.50
    expect(starter(220, 20_000)).toBe(true); // 160 over = $200.00
    expect(starter(10_000, null)).toBe(false);
  });

  it("treats a $0 cap as 'no overage': answered within the bundle, reached once it is used", () => {
    expect(starter(59, 0)).toBe(false);
    expect(starter(60, 0)).toBe(true);
  });
});
