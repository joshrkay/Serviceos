import { describe, expect, it } from "vitest";
import { priceCallUsage } from "../../src/billing/call-usage-pricing";

describe("per-call usage pricing", () => {
  it("charges nothing while Starter stays within its 50-call bundle", () => {
    expect(priceCallUsage({ planId: "starter", billableCalls: 50 })).toEqual({
      includedCalls: 50,
      billableCalls: 50,
      overageCalls: 0,
      customerChargeCents: 0,
    });
  });

  it("charges $1.50 for the first Starter call past the bundle", () => {
    expect(priceCallUsage({ planId: "starter", billableCalls: 51 })).toEqual({
      includedCalls: 50,
      billableCalls: 51,
      overageCalls: 1,
      customerChargeCents: 150,
    });
  });

  it("includes 150 calls on Growth and charges $1.25 for call 151", () => {
    expect(priceCallUsage({ planId: "growth", billableCalls: 150 })).toEqual({
      includedCalls: 150,
      billableCalls: 150,
      overageCalls: 0,
      customerChargeCents: 0,
    });
    expect(priceCallUsage({ planId: "growth", billableCalls: 151 })).toEqual({
      includedCalls: 150,
      billableCalls: 151,
      overageCalls: 1,
      customerChargeCents: 125,
    });
  });

  it("caps overage at the plan price by default", () => {
    // 80 overage calls x $1.50 = $120, capped at the $79 Starter price.
    expect(priceCallUsage({ planId: "starter", billableCalls: 130 })).toEqual({
      includedCalls: 50,
      billableCalls: 130,
      overageCalls: 80,
      customerChargeCents: 7_900,
    });
  });

  it("honours an owner-raised overage cap", () => {
    expect(
      priceCallUsage({
        planId: "starter",
        billableCalls: 130,
        overageCapCents: 20_000,
      }).customerChargeCents,
    ).toBe(12_000);
    expect(
      priceCallUsage({
        planId: "starter",
        billableCalls: 250,
        overageCapCents: 20_000,
      }).customerChargeCents,
    ).toBe(20_000);
  });

  it("charges every overage call when the owner removes the cap", () => {
    // 200 overage calls x $1.50 = $300.
    expect(
      priceCallUsage({
        planId: "starter",
        billableCalls: 250,
        overageCapCents: null,
      }).customerChargeCents,
    ).toBe(30_000);
  });

  it("rejects call counts and caps that are not non-negative integers", () => {
    expect(() =>
      priceCallUsage({ planId: "starter", billableCalls: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      priceCallUsage({ planId: "starter", billableCalls: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      priceCallUsage({
        planId: "starter",
        billableCalls: 60,
        overageCapCents: -100,
      }),
    ).toThrow(RangeError);
  });
});
