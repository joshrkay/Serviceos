import { describe, expect, it, vi } from "vitest";
import { runVoiceCostReconciliationSweep } from "../../src/workers/voice-cost-reconciliation";

describe("voice cost reconciliation", () => {
  it("records finalized Twilio cost and completes the pending item", async () => {
    const repo = {
      findDueTwilio: vi.fn(async () => [
        {
          id: "r1",
          tenantId: "t1",
          sessionId: "s1",
          callSid: "CA1",
          accountSid: "AC1",
          usageSeconds: 60,
          mediaStreamsUsed: false,
          occurredAt: new Date(),
          attempts: 0,
        },
      ]),
      record: vi.fn(async () => undefined),
      completeTwilio: vi.fn(async () => undefined),
      deferTwilio: vi.fn(async () => undefined),
    };
    const fetchFn = vi.fn(
      async () =>
        ({ ok: true, json: async () => ({ price: "-0.02" }) }) as Response,
    );
    const result = await runVoiceCostReconciliationSweep({
      tenantIds: ["t1"],
      repo,
      resolveAuthToken: async () => "token",
      fetchFn,
      mediaStreamsCentsPerHour: 24,
      now: new Date("2026-09-15T00:00:00Z"),
    });
    expect(result).toEqual({ completed: 1, deferred: 0, repeatedFailures: [] });
    expect(repo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "twilio",
        providerCostMicroCents: 2_000_000,
      }),
    );
    expect(repo.completeTwilio).toHaveBeenCalledWith("t1", "r1");
    expect(repo.record.mock.invocationCallOrder[0]).toBeLessThan(
      repo.completeTwilio.mock.invocationCallOrder[0],
    );
  });

  it("defers when Twilio has not finalized price", async () => {
    const repo = {
      findDueTwilio: vi.fn(async () => [
        {
          id: "r1",
          tenantId: "t1",
          sessionId: "s1",
          callSid: "CA1",
          accountSid: "AC1",
          usageSeconds: 60,
          mediaStreamsUsed: false,
          occurredAt: new Date(),
          attempts: 0,
        },
      ]),
      record: vi.fn(),
      completeTwilio: vi.fn(),
      deferTwilio: vi.fn(async () => undefined),
    };
    const fetchFn = vi.fn(
      async () =>
        ({ ok: true, json: async () => ({ price: null }) }) as Response,
    );
    const result = await runVoiceCostReconciliationSweep({
      tenantIds: ["t1"],
      repo,
      resolveAuthToken: async () => "token",
      fetchFn,
      mediaStreamsCentsPerHour: 24,
      now: new Date(),
    });
    expect(result).toEqual({ completed: 0, deferred: 1, repeatedFailures: [] });
    expect(repo.record).not.toHaveBeenCalled();
    expect(repo.deferTwilio).toHaveBeenCalled();
  });

  it("alerts after five failed reconciliation attempts", async () => {
    const row = {
      id: "r5",
      tenantId: "t1",
      sessionId: "s1",
      callSid: "CA5",
      accountSid: "AC1",
      usageSeconds: 60,
      mediaStreamsUsed: false,
      occurredAt: new Date(),
      attempts: 4,
    };
    const onRepeatedFailure = vi.fn(async () => undefined);
    const result = await runVoiceCostReconciliationSweep({
      tenantIds: ["t1"],
      repo: {
        findDueTwilio: vi.fn(async () => [row]),
        record: vi.fn(),
        completeTwilio: vi.fn(),
        deferTwilio: vi.fn(async () => undefined),
      },
      resolveAuthToken: async () => "token",
      fetchFn: vi.fn(async () => ({ ok: true, json: async () => ({ price: null }) }) as Response),
      mediaStreamsCentsPerHour: 24,
      onRepeatedFailure,
    });

    expect(result.repeatedFailures).toEqual([
      expect.objectContaining({ tenantId: "t1", callSid: "CA5", attempts: 5 }),
    ]);
    expect(onRepeatedFailure).toHaveBeenCalledOnce();
  });
});
