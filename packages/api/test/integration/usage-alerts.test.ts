/**
 * AI-minute usage alerts for paid plans: the owner is emailed at 80% and
 * 100% of the included minutes and when overage reaches their cap — each at
 * most once per billing period. Checked after every recorded call.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCallUsageRepository } from '../../src/billing/call-usage-events';
import { capturePostHog } from '../helpers/posthog-capture';
import { checkUsageAlerts } from '../../src/billing/usage-alerts';
import { PgOverageCapStore } from '../../src/billing/overage-cap';



const OCT = [new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 10, 1))] as const;
const NOV = [new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 11, 1))] as const;

describe('Postgres integration — AI minute usage alerts', () => {
  let pool: Pool;
  let ledger: PgCallUsageRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ledger = new PgCallUsageRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function paidTenant(period: readonly [Date, Date]) {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `UPDATE tenants SET subscription_status = 'active', plan_id = 'starter', owner_email = 'owner@shop.test',
              current_period_start = $2, current_period_end = $3 WHERE id = $1`,
      [tenantId, period[0], period[1]],
    );
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Alert Plumbing')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
    return tenantId;
  }

  async function use(tenantId: string, minutes: number, period: readonly [Date, Date] = OCT) {
    await ledger.recordCallEnded({
      tenantId, callId: `c-${randomUUID()}`, channel: 'voice_inbound', callerPhone: '+16025550123',
      endedAt: new Date(period[0].getTime() + 86_400_000), usageSeconds: minutes * 60,
    });
  }

  function subjects(sendEmail: ReturnType<typeof vi.fn>) {
    return sendEmail.mock.calls.map((c) => (c[0] as { subject: string }).subject);
  }

  it('emails once at 80%, once at 100%, then once when overage reaches the $79 cap', async () => {
    const tenantId = await paidTenant(OCT);
    const sendEmail = vi.fn(async (_email: { to: string; subject: string; text: string }) => undefined);
    const check = () => checkUsageAlerts({ pool, sendEmail, appBaseUrl: 'https://app.test' }, tenantId);

    await use(tenantId, 15);
    await check();
    expect(sendEmail).not.toHaveBeenCalled();

    await use(tenantId, 1); // 16 of 20 = 80%
    await check();
    await check();
    await use(tenantId, 4); // 20 of 20
    await check();
    await use(tenantId, 64); // 84 min: 64 over x $1.25 = $80 >= $79
    await check();
    await check();

    expect(subjects(sendEmail)).toEqual([
      "You've used 80% of your AI answering minutes",
      "You've used all your included AI answering minutes",
      'Your AI overage cap is reached — calls now ring you',
    ]);
    expect(sendEmail.mock.calls[1][0]).toMatchObject({
      to: 'owner@shop.test',
      text: expect.stringContaining('Extra minutes are $1.25 each'),
    });
  });

  it('sends only the highest newly crossed alert when one call jumps several thresholds', async () => {
    const tenantId = await paidTenant(OCT);
    const sendEmail = vi.fn(async (_email: { to: string; subject: string; text: string }) => undefined);

    await use(tenantId, 25);
    await checkUsageAlerts({ pool, sendEmail, appBaseUrl: 'https://app.test' }, tenantId);

    expect(subjects(sendEmail)).toEqual(["You've used all your included AI answering minutes"]);
  });

  it('alerts again in the next billing period', async () => {
    const tenantId = await paidTenant(OCT);
    const sendEmail = vi.fn(async (_email: { to: string; subject: string; text: string }) => undefined);
    await use(tenantId, 16);
    await checkUsageAlerts({ pool, sendEmail, appBaseUrl: 'https://app.test' }, tenantId);

    await pool.query(
      `UPDATE tenants SET current_period_start = $2, current_period_end = $3 WHERE id = $1`,
      [tenantId, NOV[0], NOV[1]],
    );
    await use(tenantId, 16, NOV);
    await checkUsageAlerts({ pool, sendEmail, appBaseUrl: 'https://app.test' }, tenantId);

    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('with a $0 cap, does not claim the cap is reached while bundle minutes remain', async () => {
    const tenantId = await paidTenant(OCT);
    await new PgOverageCapStore(pool).set(tenantId, 0);
    const sendEmail = vi.fn(async (_email: { to: string; subject: string; text: string }) => undefined);

    await use(tenantId, 17); // 85% of 20
    await checkUsageAlerts({ pool, sendEmail, appBaseUrl: 'https://app.test' }, tenantId);

    expect(subjects(sendEmail)).toEqual(["You've used 80% of your AI answering minutes"]);
  });

  it('never alerts trialing tenants (the trial nudge covers them)', async () => {
    const tenantId = await paidTenant(OCT);
    await pool.query(`UPDATE tenants SET subscription_status = 'trialing' WHERE id = $1`, [tenantId]);
    const sendEmail = vi.fn(async (_email: { to: string; subject: string; text: string }) => undefined);
    await use(tenantId, 30);

    await checkUsageAlerts({ pool, sendEmail, appBaseUrl: 'https://app.test' }, tenantId);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('records an overage_threshold event for each newly reached threshold', async () => {
    const posthog = capturePostHog();
    try {
      const tenantId = await paidTenant(OCT);
      await use(tenantId, 25);
      await checkUsageAlerts({ pool, appBaseUrl: 'https://app.test' }, tenantId);
      await checkUsageAlerts({ pool, appBaseUrl: 'https://app.test' }, tenantId);

      const thresholds = posthog
        .events()
        .filter((e) => e.event === 'overage_threshold')
        .map((e) => e.properties.threshold);
      expect(thresholds).toEqual(['included_80', 'included_100']);
    } finally {
      posthog.restore();
    }
  });
});
