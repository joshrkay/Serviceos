/**
 * Postgres integration — a Stripe `customer.subscription.*` event delivered
 * from a CONNECTED account (top-level `event.account`) must not mirror onto
 * any tenant. Rivet's own subscriptions are platform-side, so such an event
 * is never Rivet billing; before the fix its `metadata.tenant_id` chose the
 * tenant row, and the branch claimed `sub.customer` as that tenant's
 * `stripe_customer_id` and wrote its subscription status / plan.
 *
 * Real Postgres, real BillingService / PgWebhookRepository /
 * PgAuditRepository, the real Stripe route:
 *   - a connected-account event naming another tenant is refused (403):
 *     that tenant's billing columns are untouched, it gets a
 *     webhook.auth_failed audit row, the webhook row is 'failed', and no
 *     job is enqueued;
 *   - the same refusal holds when the account is the named tenant's OWN
 *     connected account, and on the customer-mapped path (no metadata);
 *   - a platform-origin event still claims the customer and mirrors the
 *     status (control).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { BillingService } from '../../src/billing/subscription';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PROVISION_TWILIO_JOB_TYPE } from '../../src/workers/provision-twilio';

const SECRET = 'whsec_subscription_account_binding';

interface BillingRow {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  trial_ends_at: Date | null;
}

describe('Postgres integration — connected-account subscription events are refused', () => {
  let pool: Pool;
  let app: express.Express;
  const sent: Array<{ type: string; payload: unknown }> = [];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        billingService: new BillingService({ pool, config: { apiKey: 'sk_test_mock' } }),
        pool,
        webhookRepo: new PgWebhookRepository(pool),
        auditRepo: new PgAuditRepository(pool),
        queue: {
          send: async (type: string, payload: unknown) => {
            sent.push({ type, payload });
            return `job-${sent.length}`;
          },
        } as never,
        stripeWebhookSecret: SECRET,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function post(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  function subscriptionEvent(opts: {
    type?: string;
    account?: string;
    tenantId?: string;
    customer: string;
    status: string;
  }) {
    const id = `evt_${randomUUID()}`;
    return {
      id,
      body: {
        id,
        type: opts.type ?? 'customer.subscription.created',
        ...(opts.account ? { account: opts.account } : {}),
        data: {
          object: {
            id: `sub_${randomUUID().slice(0, 8)}`,
            customer: opts.customer,
            status: opts.status,
            trial_end: Math.floor(Date.now() / 1000) + 14 * 86_400,
            ...(opts.tenantId ? { metadata: { tenant_id: opts.tenantId } } : {}),
          },
        },
      },
    };
  }

  async function billing(tenantId: string): Promise<BillingRow> {
    const { rows } = await pool.query<BillingRow>(
      `SELECT stripe_customer_id, stripe_subscription_id, subscription_status, trial_ends_at
         FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return rows[0];
  }

  async function webhookStatus(stripeEventId: string) {
    const { rows } = await pool.query<{ status: string; error_message: string | null }>(
      `SELECT status, error_message FROM webhook_events
        WHERE source = 'stripe' AND idempotency_key = $1`,
      [stripeEventId],
    );
    return rows[0];
  }

  async function refusalAudits(tenantId: string, stripeEventId: string) {
    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'webhook.auth_failed'
          AND entity_id = 'stripe_subscription_not_platform' AND correlation_id = $2`,
      [tenantId, stripeEventId],
    );
    return rows;
  }

  async function connectedTenant() {
    const t = await createTestTenant(pool);
    const account = `acct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await pool.query(`UPDATE tenants SET stripe_connect_account_id = $2 WHERE id = $1`, [
      t.tenantId,
      account,
    ]);
    return { tenantId: t.tenantId, account };
  }

  it("refuses an event from another tenant's connected account that names this tenant", async () => {
    const victim = await createTestTenant(pool);
    const attacker = await connectedTenant();
    const before = await billing(victim.tenantId);
    sent.length = 0;

    const evt = subscriptionEvent({
      account: attacker.account,
      tenantId: victim.tenantId,
      customer: `cus_${randomUUID().slice(0, 8)}`,
      status: 'active',
    });
    const res = await post(evt.body);

    expect(before.stripe_customer_id).toBeNull();
    expect(await billing(victim.tenantId)).toEqual(before);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('stripe_subscription_not_platform');
    expect(sent).toHaveLength(0);
    expect((await webhookStatus(evt.id)).status).toBe('failed');
    const audits = await refusalAudits(victim.tenantId, evt.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ eventAccount: attacker.account });
    // The connected account's own tenant is untouched as well.
    expect((await billing(attacker.tenantId)).stripe_customer_id).toBeNull();
  });

  it("refuses an event from the named tenant's OWN connected account (not Rivet billing)", async () => {
    const tenant = await connectedTenant();
    const before = await billing(tenant.tenantId);
    sent.length = 0;

    const evt = subscriptionEvent({
      account: tenant.account,
      tenantId: tenant.tenantId,
      customer: `cus_${randomUUID().slice(0, 8)}`,
      status: 'active',
    });
    const res = await post(evt.body);

    expect(res.status).toBe(403);
    expect(await billing(tenant.tenantId)).toEqual(before);
    expect(sent).toHaveLength(0);
  });

  it('refuses a connected-account event on the customer-mapped path (no metadata)', async () => {
    const mapped = await createTestTenant(pool);
    const customer = `cus_${randomUUID().slice(0, 8)}`;
    await pool.query(
      `UPDATE tenants SET stripe_customer_id = $2, subscription_status = 'active' WHERE id = $1`,
      [mapped.tenantId, customer],
    );
    const attacker = await connectedTenant();
    const before = await billing(mapped.tenantId);
    sent.length = 0;

    const evt = subscriptionEvent({
      type: 'customer.subscription.deleted',
      account: attacker.account,
      customer,
      status: 'canceled',
    });
    const res = await post(evt.body);

    expect(res.status).toBe(403);
    expect(await billing(mapped.tenantId)).toEqual(before);
    expect(before.subscription_status).toBe('active');
    // No number release / deprovision job for the mapped tenant.
    expect(sent).toHaveLength(0);
  });

  it('still mirrors a platform-origin event and claims its customer (control)', async () => {
    const tenant = await createTestTenant(pool);
    const customer = `cus_${randomUUID().slice(0, 8)}`;
    sent.length = 0;

    const evt = subscriptionEvent({ tenantId: tenant.tenantId, customer, status: 'trialing' });
    const res = await post(evt.body);

    expect(res.status).toBe(200);
    const after = await billing(tenant.tenantId);
    expect(after.stripe_customer_id).toBe(customer);
    expect(after.subscription_status).toBe('trialing');
    expect((await webhookStatus(evt.id)).status).toBe('processed');
    expect(sent.map((s) => s.type)).toContain(PROVISION_TWILIO_JOB_TYPE);
  });
});
