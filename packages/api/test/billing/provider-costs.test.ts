import { describe, expect, it } from "vitest";
import {
  deepgramCostMicroCents,
  elevenLabsCostMicroCents,
  twilioPriceToMicroCents,
} from "../../src/billing/provider-costs";

describe("voice provider cost conversion", () => {
  it("prices Deepgram PCM seconds from the configured contracted hourly rate", () => {
    expect(deepgramCostMicroCents(30, 29)).toBe(241_667);
  });

  it("prices ElevenLabs characters from the configured contracted per-1000 rate", () => {
    expect(elevenLabsCostMicroCents(250, 18)).toBe(4_500_000);
  });

  it("converts Twilio negative dollar prices into positive micro-cents", () => {
    expect(twilioPriceToMicroCents("-0.0125")).toBe(1_250_000);
    expect(twilioPriceToMicroCents(null)).toBeNull();
  });
});
