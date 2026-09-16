import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  type TestTenant,
} from "./shared";
import { PgVoiceUsageCostRepository } from "../../src/billing/voice-usage-cost";
import { PgVoiceUsageSettlementRepository } from "../../src/billing/voice-usage-billing";

const APP_ROLE = "voice_billing_rls_runtime";

describe("Postgres integration — AI voice usage billing", () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let usageRepo: PgVoiceUsageCostRepository;
  let settlementRepo: PgVoiceUsageSettlementRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    usageRepo = new PgVoiceUsageCostRepository(pool);
    settlementRepo = new PgVoiceUsageSettlementRepository(pool);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
  }, 120_000);

  afterAll(async () => {
    await pool.query(
      "DELETE FROM ai_voice_usage_settlements WHERE tenant_id IN ($1, $2)",
      [tenantA.tenantId, tenantB.tenantId],
    );
    await pool.query(
      "DELETE FROM ai_voice_cost_reconciliation WHERE tenant_id IN ($1, $2)",
      [tenantA.tenantId, tenantB.tenantId],
    );
    await pool.query(
      "DELETE FROM ai_voice_usage_costs WHERE tenant_id IN ($1, $2)",
      [tenantA.tenantId, tenantB.tenantId],
    );
    await closeSharedTestDb();
  });

  it("round-trips a complete per-session provider ledger without double-counting elapsed time", async () => {
    const sessionId = "voice-session-a";
    const occurredAt = new Date("2026-09-10T12:00:00.000Z");
    for (const [provider, cost] of [
      ["twilio", 1000],
      ["stt", 2000],
      ["tts", 3000],
      ["llm", 4000],
    ] as const) {
      await usageRepo.record({
        id: crypto.randomUUID(),
        tenantId: tenantA.tenantId,
        sessionId,
        sourceId: `${sessionId}:${provider}`,
        provider,
        usageSeconds: 60,
        providerCostMicroCents: cost,
        occurredAt,
      });
    }

    const summary = await usageRepo.summarizePeriod(
      tenantA.tenantId,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    );

    expect(summary).toMatchObject({
      usageSeconds: 60,
      providerCostMicroCents: 10_000,
      incompleteSessionCount: 0,
    });
    expect(summary.providers.sort()).toEqual(["llm", "stt", "tts", "twilio"]);
  });

  it("returns the canonical reconciliation id when the same session is queued twice", async () => {
    const firstId = crypto.randomUUID();
    const input = {
      id: firstId,
      tenantId: tenantA.tenantId,
      sessionId: "reconcile-session",
      callSid: "CA123",
      accountSid: "AC123",
      usageSeconds: 60,
      mediaStreamsUsed: true,
      occurredAt: new Date("2026-09-10T12:00:00.000Z"),
    };

    expect(await usageRepo.queueTwilioReconciliation(input)).toBe(firstId);
    expect(
      await usageRepo.queueTwilioReconciliation({
        ...input,
        id: crypto.randomUUID(),
      }),
    ).toBe(firstId);
  });

  it("uses one durable settlement record for retries of the same billing period", async () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const firstId = crypto.randomUUID();
    const input = {
      id: firstId,
      tenantId: tenantA.tenantId,
      periodStart,
      periodEnd,
      usageSeconds: 2400,
      providerCostMicroCents: 100_000,
      customerChargeCents: 130,
    };

    expect((await settlementRepo.ensurePending(input)).id).toBe(firstId);
    expect(
      (
        await settlementRepo.ensurePending({
          ...input,
          id: crypto.randomUUID(),
        })
      ).id,
    ).toBe(firstId);
  });

  it("RLS prevents another tenant from reading all three billing tables", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantB.tenantId],
      );
      for (const table of [
        "ai_voice_usage_costs",
        "ai_voice_cost_reconciliation",
        "ai_voice_usage_settlements",
      ]) {
        const result = await client.query(`SELECT tenant_id FROM ${table}`);
        expect(
          result.rows.some((row) => row.tenant_id === tenantA.tenantId),
        ).toBe(false);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
