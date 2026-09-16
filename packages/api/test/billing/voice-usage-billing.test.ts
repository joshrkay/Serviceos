import { describe, expect, it, vi } from "vitest";
import { VoiceUsageBillingService } from "../../src/billing/voice-usage-billing";

const TENANT = "11111111-1111-4111-8111-111111111111";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("VoiceUsageBillingService", () => {
  it("previews the actual Stripe subscription period", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ stripe_subscription_id: "sub_123" }],
      })),
    };
    const usageRepo = {
      summarizePeriod: vi.fn(async () => ({
        usageSeconds: 900,
        providerCostMicroCents: 10_000,
        providers: ["twilio", "stt", "tts", "llm"],
        incompleteSessionCount: 0,
      })),
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        response({
          current_period_start: 1_788_220_800,
          current_period_end: 1_790_899_200,
        }),
      );
    const service = new VoiceUsageBillingService({
      pool: pool as never,
      usageRepo,
      stripeApiKey: "sk_test",
      fetchFn,
      settlementRepo: {} as never,
    });

    const result = await service.previewCurrentPeriod(TENANT);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/subscriptions/sub_123",
      expect.objectContaining({ headers: { Authorization: "Bearer sk_test" } }),
    );
    expect(usageRepo.summarizePeriod).toHaveBeenCalledWith(
      TENANT,
      new Date(1_788_220_800_000),
      new Date(1_790_899_200_000),
    );
    expect(result.includedMinutes).toBe(30);
  });

  it("creates one idempotent Stripe invoice item for cost-plus overage", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ stripe_customer_id: "cus_123" }] })),
    };
    const usageRepo = {
      summarizePeriod: vi.fn(async () => ({
        usageSeconds: 2400,
        providerCostMicroCents: 400_000_000,
        providers: ["twilio", "stt", "tts", "llm"],
        incompleteSessionCount: 0,
      })),
    };
    const fetchFn = vi.fn().mockResolvedValue(response({ id: "ii_123" }));
    const settlementRepo = {
      ensurePending: vi.fn(async () => ({
        id: "set_1",
        tenantId: TENANT,
        periodStart: new Date(),
        periodEnd: new Date(),
        status: "pending" as const,
        stripeInvoiceItemId: null,
      })),
      markCompleted: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const service = new VoiceUsageBillingService({
      pool: pool as never,
      usageRepo,
      stripeApiKey: "sk_test",
      fetchFn,
      settlementRepo,
    });

    const result = await service.settlePeriod({
      tenantId: TENANT,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      invoiceItemId: "ii_123",
      customerChargeCents: 130,
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/invoiceitems");
    expect(init.headers["Idempotency-Key"]).toBe("ai-voice-overage:set_1");
    expect(init.body.get("amount")).toBe("130");
    expect(init.body.get("customer")).toBe("cus_123");
  });

  it("does not contact Stripe while usage remains inside 30 included minutes", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ stripe_customer_id: "cus_123" }] })),
    };
    const usageRepo = {
      summarizePeriod: vi.fn(async () => ({
        usageSeconds: 1800,
        providerCostMicroCents: 90_000_000,
        providers: ["twilio", "stt", "tts", "llm"],
        incompleteSessionCount: 0,
      })),
    };
    const fetchFn = vi.fn();
    const settlementRepo = {
      ensurePending: vi.fn(),
      markCompleted: vi.fn(),
      fail: vi.fn(),
    };
    const service = new VoiceUsageBillingService({
      pool: pool as never,
      usageRepo,
      stripeApiKey: "sk_test",
      fetchFn,
      settlementRepo: settlementRepo as never,
    });

    const result = await service.settlePeriod({
      tenantId: TENANT,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      invoiceItemId: null,
      customerChargeCents: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports an unused period as complete without requiring provider rows", async () => {
    const usageRepo = {
      summarizePeriod: vi.fn(async () => ({
        usageSeconds: 0,
        providerCostMicroCents: 0,
        providers: [],
        incompleteSessionCount: 0,
      })),
    };
    const service = new VoiceUsageBillingService({
      pool: {} as never,
      usageRepo,
      stripeApiKey: "sk_test",
      settlementRepo: {} as never,
    });

    const preview = await service.previewPeriod({
      tenantId: TENANT,
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });

    expect(preview.complete).toBe(true);
    expect(preview.projectedChargeCents).toBe(0);
  });

  it("fails closed when any required provider cost is missing", async () => {
    const pool = { query: vi.fn() };
    const usageRepo = {
      summarizePeriod: vi.fn(async () => ({
        usageSeconds: 2400,
        providerCostMicroCents: 100_000_000,
        providers: ["llm", "twilio"],
        incompleteSessionCount: 1,
      })),
    };
    const fetchFn = vi.fn();
    const settlementRepo = {
      ensurePending: vi.fn(),
      markCompleted: vi.fn(),
      fail: vi.fn(),
    };
    const service = new VoiceUsageBillingService({
      pool: pool as never,
      usageRepo,
      stripeApiKey: "sk_test",
      fetchFn,
      settlementRepo: settlementRepo as never,
    });

    await expect(
      service.settlePeriod({
        tenantId: TENANT,
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/incomplete.*stt.*tts/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("records a failed settlement when Stripe omits the invoice item id", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ stripe_customer_id: "cus_123" }] })),
    };
    const usageRepo = {
      summarizePeriod: vi.fn(async () => ({
        usageSeconds: 2400,
        providerCostMicroCents: 400_000_000,
        providers: ["twilio", "stt", "tts", "llm"],
        incompleteSessionCount: 0,
      })),
    };
    const settlementRepo = {
      ensurePending: vi.fn(async () => ({
        id: "set_1",
        tenantId: TENANT,
        periodStart: new Date(),
        periodEnd: new Date(),
        status: "pending" as const,
        stripeInvoiceItemId: null,
      })),
      markCompleted: vi.fn(),
      fail: vi.fn(async () => undefined),
    };
    const service = new VoiceUsageBillingService({
      pool: pool as never,
      usageRepo,
      stripeApiKey: "sk_test",
      fetchFn: vi.fn().mockResolvedValue(response({})),
      settlementRepo,
    });

    await expect(
      service.settlePeriod({
        tenantId: TENANT,
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/returned no id/);
    expect(settlementRepo.fail).toHaveBeenCalledWith(
      TENANT,
      "set_1",
      expect.stringMatching(/no id/),
    );
  });
});
