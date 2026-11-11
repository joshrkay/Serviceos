/**
 * Postgres integration — the `trial_to_paid` funnel event's "has this
 * subscription already been reported active?" check (src/webhooks/routes.ts,
 * isFirstConversionToPaid) against the REAL `webhook_events` table.
 *
 * The unit test (test/webhooks/stripe-subscription-funnel.test.ts) pins the
 * decision logic with a fake pool; this pins the SQL itself — the real column
 * names (`source`, `event_type`, `id`, `payload`), the JSON paths into the
 * minimized receipt (`payload->'object'->>'id'` / `'status'`), and that the
 * current delivery's own receipt does not count as a prior one.
 *
 * Real Postgres, real BillingService / PgWebhookRepository / PgAuditRepository,
 * the real Stripe route, the real PostHog capture path (client faked):
 *   - a trial whose first charge fails and then recovers
 *     (trialing → past_due → active) is counted once, from_status 'past_due';
 *   - a later renewal failure + recovery is NOT counted again;
 *   - a recovery conversion is not counted again by a later failure + recovery;
 *   - the check is per subscription: a tenant's NEW subscription converting is
 *     its own conversion, the same as a clean trialing → active already was.
 *
 * `webhook_events` is global and shared by every file in the run, so each test
 * uses its own subscription id.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { capturePostHog } from '../helpers/posthog-capture';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { BillingService } from '../../src/billing/subscription';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgAuditRepository } from '../../src/audit/pg-audit';

const SECRET = 'whsec_subscription_funnel_integration';

describe('Postgres integration — trial_to_paid counts a first paid period once', () => {
  let pool: Pool;
  let app: express.Express;
  let posthog: ReturnType<typeof capturePostHog>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    posthog = capturePostHog();
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        billingService: new BillingService({ pool, config: { apiKey: 'sk_test_mock' } }),
        pool,
        webhookRepo: new PgWebhookRepository(pool),
        auditRepo: new PgAuditRepository(pool),
        stripeWebhookSecret: SECRET,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    posthog.restore();
    await closeSharedTestDb();
  });

  async function deliver(
    tenantId: string,
    customerId: string,
    subscriptionId: string,
    type: 'customer.subscription.created' | 'customer.subscription.updated',
    status: string,
  ): Promise<void> {
    const raw = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type,
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status,
          metadata: { tenant_id: tenantId },
        },
      },
    });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);
  }

  /** Deliver the statuses in order: `created` for the first, `updated` after. */
  async function deliverStatuses(
    tenantId: string,
    customerId: string,
    subscriptionId: string,
    statuses: string[],
  ): Promise<void> {
    for (const [i, status] of statuses.entries()) {
      await deliver(
        tenantId,
        customerId,
        subscriptionId,
        i === 0 ? 'customer.subscription.created' : 'customer.subscription.updated',
        status,
      );
    }
  }

  const newCustomerId = () => `cus_${randomUUID().slice(0, 12)}`;
  const newSubscriptionId = () => `sub_${randomUUID().slice(0, 12)}`;

  const conversionsFor = (tenantId: string) =>
    posthog
      .events()
      .filter((e) => e.event === 'trial_to_paid' && e.properties.tenantId === tenantId);

  it('counts a trial whose first charge failed (trialing → past_due → active) once', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const subscriptionId = newSubscriptionId();

    await deliverStatuses(tenantId, newCustomerId(), subscriptionId, [
      'trialing',
      'past_due',
      'active',
    ]);

    const conversions = conversionsFor(tenantId);
    expect(conversions).toHaveLength(1);
    expect(conversions[0]).toMatchObject({
      distinctId: userId,
      properties: expect.objectContaining({ subscriptionId, from_status: 'past_due' }),
    });
  });

  it('does not count a later renewal failure and recovery after a clean conversion', async () => {
    const { tenantId } = await createTestTenant(pool);

    await deliverStatuses(tenantId, newCustomerId(), newSubscriptionId(), [
      'trialing',
      'active',
      'past_due',
      'active',
    ]);

    const conversions = conversionsFor(tenantId);
    expect(conversions).toHaveLength(1);
    expect(conversions[0].properties.from_status).toBe('trialing');
  });

  it('counts the recovery conversion once even when the card fails again later', async () => {
    const { tenantId } = await createTestTenant(pool);

    await deliverStatuses(tenantId, newCustomerId(), newSubscriptionId(), [
      'trialing',
      'past_due',
      'active',
      'past_due',
      'active',
    ]);

    const conversions = conversionsFor(tenantId);
    expect(conversions).toHaveLength(1);
    expect(conversions[0].properties.from_status).toBe('past_due');
  });

  it("counts a tenant's new subscription converting as its own conversion (the check is per subscription)", async () => {
    const { tenantId } = await createTestTenant(pool);
    const customerId = newCustomerId();
    const first = newSubscriptionId();
    const second = newSubscriptionId();

    await deliverStatuses(tenantId, customerId, first, ['trialing', 'active']);
    await deliverStatuses(tenantId, customerId, second, ['trialing', 'past_due', 'active']);

    const conversions = conversionsFor(tenantId);
    expect(conversions.map((c) => c.properties.subscriptionId)).toEqual([first, second]);
    expect(conversions.map((c) => c.properties.from_status)).toEqual(['trialing', 'past_due']);
  });
});
