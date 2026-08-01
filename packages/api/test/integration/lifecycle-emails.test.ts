/**
 * Docker-gated integration test for the onboarding email persistence:
 *   - the lifecycle_emails ON CONFLICT ledger claim against real Postgres
 *     (the at-most-once gate the welcome event + sweeps depend on), and
 *   - the trial_ends_at write through BillingService.applySubscriptionEvent.
 *
 * Mocked-pool unit tests can't prove the UNIQUE/ON CONFLICT semantics or the
 * column exists — per CLAUDE.md, DB-touching changes need a real-DB test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { BillingService } from '../../src/billing/subscription';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createLogger } from '../../src/logging/logger';
import {
  claimLifecycleEmail,
  sendLifecycleEmail,
} from '../../src/notifications/lifecycle-email';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const rendered = { subject: 's', text: 't', html: '<p>t</p>' };

describe('lifecycle_emails ledger (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('claimLifecycleEmail is true once, then false for the same (tenant, kind)', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimLifecycleEmail(pool, tenantId, 'welcome')).toBe(true);
    expect(await claimLifecycleEmail(pool, tenantId, 'welcome')).toBe(false);
    // A different kind is independent.
    expect(await claimLifecycleEmail(pool, tenantId, 'trial_3d')).toBe(true);
  });

  it('sendLifecycleEmail sends once and reports duplicate on replay', async () => {
    const { tenantId } = await createTestTenant(pool);
    const delivery = new InMemoryDeliveryProvider();

    const first = await sendLifecycleEmail(
      { pool, delivery, logger },
      { tenantId, kind: 'welcome', to: 'owner@shop.com', rendered },
    );
    const second = await sendLifecycleEmail(
      { pool, delivery, logger },
      { tenantId, kind: 'welcome', to: 'owner@shop.com', rendered },
    );

    expect(first).toBe('sent');
    expect(second).toBe('duplicate');
    expect(delivery.sentEmails).toHaveLength(1);
  });

  it('releases the claim when the transport throws so a retry can re-send', async () => {
    const { tenantId } = await createTestTenant(pool);
    const throwing = {
      sendSms: async () => {
        throw new Error('nope');
      },
      sendEmail: async () => {
        throw new Error('transport down');
      },
    };

    await expect(
      sendLifecycleEmail(
        { pool, delivery: throwing, logger },
        { tenantId, kind: 'welcome', to: 'owner@shop.com', rendered },
      ),
    ).rejects.toThrow(/transport down/);

    // Claim was rolled back → re-claimable.
    expect(await claimLifecycleEmail(pool, tenantId, 'welcome')).toBe(true);
  });

  it('applySubscriptionEvent persists trial_ends_at on the tenant row', async () => {
    const { tenantId } = await createTestTenant(pool);
    const customerId = `cus_${tenantId.slice(0, 8)}`;
    await pool.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, tenantId]);

    const svc = new BillingService({ pool, config: { apiKey: 'sk_test_x' } });
    const trialEnd = new Date('2026-07-01T00:00:00.000Z');
    await svc.applySubscriptionEvent({
      customerId,
      subscriptionId: 'sub_int_1',
      status: 'trialing',
      trialEndsAt: trialEnd,
    });

    const { rows } = await pool.query<{ trial_ends_at: Date; subscription_status: string }>(
      `SELECT trial_ends_at, subscription_status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(rows[0].subscription_status).toBe('trialing');
    expect(new Date(rows[0].trial_ends_at).toISOString()).toBe(trialEnd.toISOString());
  });
});
