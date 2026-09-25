import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  type TestTenant,
} from "./shared";
import { PgCallUsageRepository } from "../../src/billing/call-usage-events";

const APP_ROLE = "call_usage_rls_runtime";
const PERIOD_START = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-10-01T00:00:00.000Z");

describe("Postgres integration — per-call usage ledger", () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let repo: PgCallUsageRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    repo = new PgCallUsageRepository(pool);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT ON call_usage_events TO ${APP_ROLE}`);
  }, 120_000);

  afterAll(async () => {
    await pool.query("DELETE FROM call_usage_events WHERE tenant_id = $1", [
      tenantA.tenantId,
    ]);
    await closeSharedTestDb();
  });

  it("counts a billable call once even when its end is recorded twice", async () => {
    const call = {
      tenantId: tenantA.tenantId,
      callId: "session-once",
      channel: "voice_inbound" as const,
      callerPhone: "+16025550101",
      endedAt: new Date("2026-09-10T12:02:00.000Z"),
      usageSeconds: 120,
    };
    await repo.recordCallEnded(call);
    await repo.recordCallEnded(call);

    expect(
      await repo.countBillableCalls(tenantA.tenantId, PERIOD_START, PERIOD_END),
    ).toBe(1);
  });

  it("treats a same-number callback within 10 minutes as the same call", async () => {
    const caller = "+16025550202";
    const tenantId = tenantA.tenantId;
    const before = await repo.countBillableCalls(tenantId, PERIOD_START, PERIOD_END);

    // First call 13:00:00-13:02:00.
    await repo.recordCallEnded({
      tenantId, callId: "session-first", channel: "voice_inbound", callerPhone: caller,
      endedAt: new Date("2026-09-11T13:02:00.000Z"), usageSeconds: 120,
    });
    // Callback starts 13:11:00 — 9 minutes after the first call ended.
    await repo.recordCallEnded({
      tenantId, callId: "session-callback", channel: "voice_inbound", callerPhone: caller,
      endedAt: new Date("2026-09-11T13:12:00.000Z"), usageSeconds: 60,
    });
    // Next call starts 13:23:00 — 21 minutes after the last counted call ended.
    await repo.recordCallEnded({
      tenantId, callId: "session-later", channel: "voice_inbound", callerPhone: caller,
      endedAt: new Date("2026-09-11T13:24:00.000Z"), usageSeconds: 60,
    });

    expect(
      (await repo.countBillableCalls(tenantId, PERIOD_START, PERIOD_END)) - before,
    ).toBe(2);
  });

  it("does not count the owner's onboarding test call", async () => {
    const tenantId = tenantA.tenantId;
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name, owner_phone)
       VALUES ($1, 'Test Plumbing', $2)
       ON CONFLICT (tenant_id) DO UPDATE SET owner_phone = EXCLUDED.owner_phone`,
      [tenantId, "+14805550100"],
    );
    const before = await repo.countBillableCalls(tenantId, PERIOD_START, PERIOD_END);

    await repo.recordCallEnded({
      tenantId, callId: "session-owner-test", channel: "voice_inbound",
      callerPhone: "+14805550100",
      endedAt: new Date("2026-09-12T09:03:00.000Z"), usageSeconds: 180,
    });

    expect(await repo.countBillableCalls(tenantId, PERIOD_START, PERIOD_END)).toBe(before);
  });

  it("RLS prevents another tenant from reading the call ledger", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
        tenantB.tenantId,
      ]);
      const result = await client.query("SELECT tenant_id FROM call_usage_events");
      expect(result.rows.some((row) => row.tenant_id === tenantA.tenantId)).toBe(false);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
