/**
 * The voice gate's usage caps, measured from the AI-minute ledger:
 * trials forward to the owner at 60 minutes or 2 concurrent calls, paid
 * plans forward once overage reaches its cap (one plan price by default).
 * A forward carries the owner's phone; with none on file it has none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createVoiceGate } from '../../src/voice/voice-gate';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';
import { PgOverageCapStore } from '../../src/billing/overage-cap';

const OWNER_PHONE = '+14805550100';
const PERIOD_START = new Date(Date.UTC(2026, 9, 1));
const PERIOD_END = new Date(Date.UTC(2026, 10, 1));

describe('Postgres integration — voice gate usage caps', () => {
  let pool: Pool;
  let ledger: PgCallUsageRepository;
  let gate: ReturnType<typeof createVoiceGate>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ledger = new PgCallUsageRepository(pool);
    gate = createVoiceGate({ pool, auditRepo: new InMemoryAuditRepository() });
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function liveTenant(opts: {
    status: 'trialing' | 'active';
    planId?: 'starter' | 'growth';
    ownerPhone?: string | null;
  }) {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `UPDATE tenants SET subscription_status = $2, plan_id = $3,
              current_period_start = $4, current_period_end = $5 WHERE id = $1`,
      [tenantId, opts.status, opts.planId ?? 'starter', PERIOD_START, PERIOD_END],
    );
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name, owner_phone, voice_agent_live_at, e1_reviewed_script)
       VALUES ($1, 'Gate Plumbing', $2, NOW(), 'Reviewed safety script')
       ON CONFLICT (tenant_id) DO UPDATE SET owner_phone = EXCLUDED.owner_phone,
         voice_agent_live_at = EXCLUDED.voice_agent_live_at, e1_reviewed_script = EXCLUDED.e1_reviewed_script`,
      [tenantId, opts.ownerPhone === undefined ? OWNER_PHONE : opts.ownerPhone],
    );
    return tenantId;
  }

  async function useSeconds(tenantId: string, seconds: number, callerPhone = '+16025550123') {
    await ledger.recordCallEnded({
      tenantId,
      callId: `call-${randomUUID()}`,
      channel: 'voice_inbound',
      callerPhone,
      endedAt: new Date(PERIOD_START.getTime() + 86_400_000),
      usageSeconds: seconds,
    });
  }

  const check = (tenantId: string) => gate({ tenantId, callSid: `CA${randomUUID().slice(0, 8)}` });

  it('answers a trial under 60 minutes and forwards to the owner at 60', async () => {
    const tenantId = await liveTenant({ status: 'trialing' });
    await useSeconds(tenantId, 3_599);
    expect(await check(tenantId)).toEqual({ allowed: true });

    await useSeconds(tenantId, 1);
    expect(await check(tenantId)).toEqual({
      allowed: false,
      reason: 'trial_cap_total',
      forwardTo: OWNER_PHONE,
    });
  });

  it("never spends trial minutes on the owner's own test calls", async () => {
    const tenantId = await liveTenant({ status: 'trialing' });
    await useSeconds(tenantId, 3_600, OWNER_PHONE);

    expect(await check(tenantId)).toEqual({ allowed: true });
  });

  it('forwards a third concurrent trial call', async () => {
    const tenantId = await liveTenant({ status: 'trialing' });
    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `INSERT INTO voice_sessions (tenant_id, channel, state) VALUES ($1, 'voice_inbound', 'greeting')`,
        [tenantId],
      );
    }

    expect(await check(tenantId)).toMatchObject({ allowed: false, reason: 'trial_cap_concurrent' });
  });

  it('forwards a paid Starter call once overage reaches the $79 default cap', async () => {
    const tenantId = await liveTenant({ status: 'active', planId: 'starter' });
    // 83 minutes: 63 over x $1.25 = $78.75 — still under the cap.
    await useSeconds(tenantId, 83 * 60);
    expect(await check(tenantId)).toEqual({ allowed: true });

    // 84 minutes: 64 over x $1.25 = $80.00 — cap reached.
    await useSeconds(tenantId, 60);
    expect(await check(tenantId)).toEqual({
      allowed: false,
      reason: 'overage_cap',
      forwardTo: OWNER_PHONE,
    });
  });

  it('has nowhere to forward when no owner phone is on file', async () => {
    const tenantId = await liveTenant({ status: 'trialing', ownerPhone: null });
    await useSeconds(tenantId, 3_600);

    expect(await check(tenantId)).toEqual({
      allowed: false,
      reason: 'trial_cap_total',
      forwardTo: null,
    });
  });

  it("uses the owner's cap: keeps answering past $79 when raised, never forwards when removed", async () => {
    const caps = new PgOverageCapStore(pool);
    const raised = await liveTenant({ status: 'active', planId: 'starter' });
    await caps.set(raised, 20_000);
    await useSeconds(raised, 84 * 60); // $80.00 of overage — past the default cap
    expect(await check(raised)).toEqual({ allowed: true });
    await useSeconds(raised, 116 * 60); // 200 min: $225.00 — past the raised cap
    expect(await check(raised)).toMatchObject({ allowed: false, reason: 'overage_cap' });

    const removed = await liveTenant({ status: 'active', planId: 'starter' });
    await caps.set(removed, null);
    await useSeconds(removed, 1_000 * 60);
    expect(await check(removed)).toEqual({ allowed: true });
  });

  it('with a $0 cap, keeps answering inside the bundle and forwards once it is used up', async () => {
    const caps = new PgOverageCapStore(pool);
    const tenantId = await liveTenant({ status: 'active', planId: 'starter' });
    await caps.set(tenantId, 0);

    await useSeconds(tenantId, 19 * 60);
    expect(await check(tenantId)).toEqual({ allowed: true });

    await useSeconds(tenantId, 60);
    expect(await check(tenantId)).toMatchObject({ allowed: false, reason: 'overage_cap' });
  });
});
