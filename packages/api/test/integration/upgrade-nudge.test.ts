/**
 * The trial upgrade nudge fires once, at 40 billable AI minutes (of the
 * 60-minute trial) — measured from the AI-minute ledger, so the owner's own
 * setup test calls never count toward it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { capturePostHog } from '../helpers/posthog-capture';
import { checkAndFireUpgradeNudge } from '../../src/voice/check-upgrade-nudge';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';

const OWNER_PHONE = '+14805550100';


describe('Postgres integration — trial upgrade nudge', () => {
  let pool: Pool;
  let ledger: PgCallUsageRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ledger = new PgCallUsageRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function trialTenant() {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `UPDATE tenants SET subscription_status = 'trialing', owner_email = 'owner@shop.test' WHERE id = $1`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name, owner_phone) VALUES ($1, 'Nudge Plumbing', $2)
       ON CONFLICT (tenant_id) DO UPDATE SET owner_phone = EXCLUDED.owner_phone`,
      [tenantId, OWNER_PHONE],
    );
    return tenantId;
  }

  async function use(tenantId: string, seconds: number, callerPhone = '+16025550123') {
    await ledger.recordCallEnded({
      tenantId, callId: `c-${randomUUID()}`, channel: 'voice_inbound',
      callerPhone, endedAt: new Date(), usageSeconds: seconds,
    });
  }

  it('fires once at 40 billable minutes and emails the owner', async () => {
    const tenantId = await trialTenant();
    const sendEmail = vi.fn(async () => undefined);

    await use(tenantId, 39 * 60);
    expect(await checkAndFireUpgradeNudge({ pool, sendEmail }, tenantId)).toEqual({ fired: false });

    await use(tenantId, 60);
    expect(await checkAndFireUpgradeNudge({ pool, sendEmail }, tenantId)).toEqual({ fired: true });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@shop.test',
        text: expect.stringContaining("You've used 40 of your 60 trial AI minutes"),
      }),
    );

    await use(tenantId, 600);
    expect(await checkAndFireUpgradeNudge({ pool, sendEmail }, tenantId)).toEqual({ fired: false });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not count the owner's own test calls", async () => {
    const tenantId = await trialTenant();
    await use(tenantId, 50 * 60, OWNER_PHONE);

    expect(await checkAndFireUpgradeNudge({ pool }, tenantId)).toEqual({ fired: false });
  });

  it('records a trial_minutes_milestone funnel event when the nudge fires', async () => {
    const posthog = capturePostHog();
    try {
      const tenantId = await trialTenant();
      await use(tenantId, 40 * 60);
      await checkAndFireUpgradeNudge({ pool }, tenantId);

      expect(posthog.events()).toContainEqual(
        expect.objectContaining({
          event: 'trial_minutes_milestone',
          properties: expect.objectContaining({ tenant_id: tenantId, trial_minutes_used: 40 }),
        }),
      );
    } finally {
      posthog.restore();
    }
  });
});
