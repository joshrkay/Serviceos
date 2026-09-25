import { describe, expect, it } from "vitest";
import { classifyCall } from "../../src/billing/call-usage-events";

const tenantPhones = {
  ownerPhone: "+14805550100",
  businessPhone: "+14805550199",
};

describe("billable call classification", () => {
  it("does not bill a call shorter than 30 seconds", () => {
    expect(
      classifyCall(
        { channel: "voice_inbound", usageSeconds: 29, callerPhone: "+16025550123" },
        tenantPhones,
      ),
    ).toEqual({ billable: false, reason: "under_30_seconds" });
  });

  it("bills an AI-answered call of exactly 30 seconds", () => {
    expect(
      classifyCall(
        { channel: "voice_inbound", usageSeconds: 30, callerPhone: "+16025550123" },
        tenantPhones,
      ),
    ).toEqual({ billable: true });
  });

  it("never bills calls from the business's own owner or business phone", () => {
    // Formatting differs from the stored settings on purpose.
    expect(
      classifyCall(
        { channel: "voice_inbound", usageSeconds: 120, callerPhone: "(480) 555-0100" },
        tenantPhones,
      ),
    ).toEqual({ billable: false, reason: "own_number" });
    expect(
      classifyCall(
        { channel: "voice_inbound", usageSeconds: 120, callerPhone: "+14805550199" },
        tenantPhones,
      ),
    ).toEqual({ billable: false, reason: "own_number" });
  });

  it("never bills in-app voice sessions, which are not phone calls", () => {
    expect(
      classifyCall({ channel: "inapp_voice", usageSeconds: 300 }, tenantPhones),
    ).toEqual({ billable: false, reason: "not_inbound_call" });
  });
});
