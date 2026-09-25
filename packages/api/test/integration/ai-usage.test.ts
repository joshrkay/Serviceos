/**
 * The AI-minute usage summary behind GET /api/billing/ai-usage: what the
 * owner has used this period (or this trial), what is included, and what
 * the overage would cost after their cap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';
import { PgOverageCapStore } from '../../src/billing/overage-cap';
import { AiUsageReader } from '../../src/billing/ai-usage';

const PERIOD_START = new Date(Date.UTC(2026, 9, 1));
const PERIOD_END = new Date(Date.UTC(2026, 10, 1));

describe('Postgres integration — AI minute usage summary', () => {
  let pool: Pool;
  let ledger: PgCallUsageRepository;
  let caps: PgOverageCapStore;
  let reader: AiUsageReader;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ledger = new PgCallUsageRepository(pool);
    caps = new PgOverageCapStore(pool);
    reader = new AiUsageReader(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function tenantOn(status: 'trialing' | 'active', planId: 'starter' | 'growth') {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `UPDATE tenants SET subscription_status = $2, plan_id = $3,
              current_period_start = $4, current_period_end = $5 WHERE id = $1`,
      [tenantId, status, planId, PERIOD_START, PERIOD_END],
    );
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Usage Plumbing')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
    return tenantId;
  }

  async function use(tenantId: string, seconds: number, endedAt = new Date(PERIOD_START.getTime() + 86_400_000)) {
    await ledger.recordCallEnded({
      tenantId, callId: `c-${randomUUID()}`, channel: 'voice_inbound',
      callerPhone: '+16025550123', endedAt, usageSeconds: seconds,
    });
  }

  it("reports this period's minutes, overage and projected charge for a paid plan", async () => {
    const tenantId = await tenantOn('active', 'starter');
    await use(tenantId, 1_469); // 24.5 min → 25
    await use(tenantId, 600, new Date(PERIOD_START.getTime() - 86_400_000)); // last period

    expect(await reader.getUsage(tenantId)).toEqual({
      kind: 'period',
      planId: 'starter',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      usedMinutes: 25,
      includedMinutes: 20,
      overageMinutes: 5,
      overageCentsPerMinute: 125,
      projectedChargeCents: 625,
      capCents: 7_900,
    });
  });

  it('shows the capped projection and a removed cap as null', async () => {
    const tenantId = await tenantOn('active', 'starter');
    await use(tenantId, 200 * 60);
    expect(await reader.getUsage(tenantId)).toMatchObject({ projectedChargeCents: 7_900, capCents: 7_900 });

    await caps.set(tenantId, null);
    expect(await reader.getUsage(tenantId)).toMatchObject({ projectedChargeCents: 22_500, capCents: null });
  });

  it('reports trial minutes against the 60-minute trial', async () => {
    const tenantId = await tenantOn('trialing', 'growth');
    await use(tenantId, 45 * 60);

    expect(await reader.getUsage(tenantId)).toEqual({
      kind: 'trial',
      planId: 'growth',
      usedMinutes: 45,
      includedMinutes: 60,
    });
  });
});
