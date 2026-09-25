import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  type TestTenant,
} from "./shared";
import { PgCallUsageRepository } from "../../src/billing/call-usage-events";
import {
  CallUsageBillingService,
  PgCallUsageSettlementRepository,
} from "../../src/billing/call-usage-billing";

const STARTER_PRICE = "price_starter_test";
const GROWTH_PRICE = "price_growth_test";

/**
 * Fake Stripe invoice-items endpoint. Like Stripe, a repeated
 * Idempotency-Key returns the original item instead of creating another.
 */
function fakeStripe() {
  const items = new Map<string, { id: string; amount: number; customer: string }>();
  let failNext = 0;
  let requests = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests += 1;
    if (failNext > 0) {
      failNext -= 1;
      return new Response("stripe unavailable", { status: 503 });
    }
    const key = (init.headers as Record<string, string>)["Idempotency-Key"];
    const body = init.body as URLSearchParams;
    if (!items.has(key)) {
      items.set(key, {
        id: `ii_${items.size + 1}`,
        amount: Number(body.get("amount")),
        customer: body.get("customer") ?? "",
      });
    }
    return new Response(JSON.stringify({ id: items.get(key)!.id }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    items: () => [...items.values()],
    requests: () => requests,
    failNextRequests: (n: number) => {
      failNext = n;
    },
  };
}

describe("Postgres integration — AI minute overage settlement", () => {
  let pool: Pool;
  let ledger: PgCallUsageRepository;
  let tenant: TestTenant;
  let stripe: ReturnType<typeof fakeStripe>;
  let service: CallUsageBillingService;
  let periodIndex = 0;
  let period: { start: Date; end: Date };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ledger = new PgCallUsageRepository(pool);
  }, 120_000);

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    await pool.query("UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1", [
      tenant.tenantId,
      `cus_${tenant.tenantId.slice(0, 8)}`,
    ]);
    stripe = fakeStripe();
    service = new CallUsageBillingService({
      pool,
      settlementRepo: new PgCallUsageSettlementRepository(pool),
      callUsage: ledger,
      stripeApiKey: "sk_test",
      fetchFn: stripe.fetchFn,
      planForPriceId: (priceId) =>
        priceId === STARTER_PRICE ? "starter" : priceId === GROWTH_PRICE ? "growth" : null,
    });
    periodIndex += 1;
    period = {
      start: new Date(Date.UTC(2026, periodIndex, 1)),
      end: new Date(Date.UTC(2026, periodIndex + 1, 1)),
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Records `n` distinct 2-minute customer calls inside the period. */
  async function recordTwoMinuteCalls(n: number) {
    for (let i = 0; i < n; i += 1) {
      await ledger.recordCallEnded({
        tenantId: tenant.tenantId,
        callId: `call-${periodIndex}-${i}`,
        channel: "voice_inbound",
        callerPhone: `+1602555${String(1000 + i).padStart(4, "0")}`,
        endedAt: new Date(period.start.getTime() + (i + 1) * 3_600_000),
        usageSeconds: 120,
      });
    }
  }

  function settle(subscriptionPriceId = STARTER_PRICE) {
    return service.settlePeriod({
      tenantId: tenant.tenantId,
      periodStart: period.start,
      periodEnd: period.end,
      subscriptionPriceId,
      stripeInvoiceId: "in_test",
    });
  }

  it("invoices a Starter period with 60 AI minutes as one $50.00 overage item", async () => {
    await recordTwoMinuteCalls(30);

    const result = await settle();

    expect(result).toMatchObject({ billableMinutes: 60, overageMinutes: 40, customerChargeCents: 5_000 });
    expect(stripe.items()).toEqual([
      { id: "ii_1", amount: 5_000, customer: `cus_${tenant.tenantId.slice(0, 8)}` },
    ]);
  });

  it("completes a period inside the bundle without touching Stripe", async () => {
    await recordTwoMinuteCalls(10);

    const result = await settle();

    expect(result).toMatchObject({ billableMinutes: 20, overageMinutes: 0, customerChargeCents: 0, invoiceItemId: null });
    expect(stripe.items()).toEqual([]);
  });

  it("re-delivering a settled period's invoice webhook never calls Stripe again", async () => {
    await recordTwoMinuteCalls(11);

    const first = await settle();
    const again = await settle();

    expect(again).toEqual(first);
    expect(stripe.requests()).toBe(1);
    expect(stripe.items()).toHaveLength(1);
  });

  it("retries a failed Stripe attempt and charges exactly once, at the original amount", async () => {
    await recordTwoMinuteCalls(11);
    stripe.failNextRequests(1);

    await expect(settle()).rejects.toThrow(/Stripe AI minute overage invoice item failed \(503\)/);
    // A late ledger write between attempts must not change what is charged.
    await ledger.recordCallEnded({
      tenantId: tenant.tenantId, callId: `late-${periodIndex}`, channel: "voice_inbound",
      callerPhone: "+16025559999", endedAt: new Date(period.start.getTime() + 1_000),
      usageSeconds: 60,
    });
    const retried = await settle();

    expect(retried).toMatchObject({ overageMinutes: 2, customerChargeCents: 250 });
    expect(stripe.items()).toEqual([
      { id: "ii_1", amount: 250, customer: `cus_${tenant.tenantId.slice(0, 8)}` },
    ]);
  });

  it("prices the period on the plan the invoice carries (upgraded to Growth: no overage)", async () => {
    await recordTwoMinuteCalls(30);

    const result = await settle(GROWTH_PRICE);

    expect(result).toMatchObject({ planId: "growth", overageMinutes: 0, customerChargeCents: 0 });
    expect(stripe.requests()).toBe(0);
  });

  it("refuses to settle against an unknown subscription price", async () => {
    await recordTwoMinuteCalls(30);

    await expect(settle("price_unknown")).rejects.toThrow(/Unknown subscription price/);
    expect(stripe.requests()).toBe(0);
  });

  it("RLS prevents another tenant from reading settlements", async () => {
    await recordTwoMinuteCalls(30);
    await settle();
    const other = await createTestTenant(pool);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'call_settlement_rls_runtime') THEN
        CREATE ROLE call_settlement_rls_runtime NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query("GRANT USAGE ON SCHEMA public TO call_settlement_rls_runtime");
    await pool.query("GRANT SELECT ON call_usage_settlements TO call_settlement_rls_runtime");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE call_settlement_rls_runtime");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [other.tenantId]);
      const rows = await client.query("SELECT tenant_id FROM call_usage_settlements");
      expect(rows.rows.some((row) => row.tenant_id === tenant.tenantId)).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
