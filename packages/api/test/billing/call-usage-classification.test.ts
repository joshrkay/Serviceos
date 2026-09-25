import { describe, expect, it } from "vitest";
import { classifyCall } from "../../src/billing/call-usage-events";

const tenantPhones = {
  ownerPhone: "+14805550100",
  businessPhone: "+14805550199",
};

describe("billable AI answering classification", () => {
  it("bills every second of an AI-answered inbound call, even a 12-second one", () => {
    expect(
      classifyCall(
        { channel: "voice_inbound", usageSeconds: 12, callerPhone: "+16025550123" },
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
