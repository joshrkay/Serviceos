/**
 * Stripe `customer.subscription.*` auto-deprovision trigger in
 * src/webhooks/routes.ts. A true cancellation enqueues a tenant hard-delete
 * job — but only when AUTO_DEPROVISION_ON_CANCEL is set, and never on dunning
 * states (past_due / unpaid).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { DEPROVISION_TENANT_JOB_TYPE } from '../../src/workers/deprovision-tenant';

const STRIPE_SECRET = 'whsec_test_sub';
const TENANT = '22222222-2222-2222-2222-222222222222';

function buildApp(send: ReturnType<typeof vi.fn>, tenantExists = true) {
  const pool = {
    query: vi.fn(async () => ({
      rowCount: tenantExists ? 1 : 0,
      rows: tenantExists ? [{ id: TENANT }] : [],
    })),
  };
  const deps = {
    billingService: { applySubscriptionEvent: vi.fn(async () => undefined) } as never,
    pool: pool as never,
    queue: { send } as never,
    auditRepo: new InMemoryAuditRepository(),
    stripeWebhookSecret: STRIPE_SECRET,
  };
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use('/webhooks', createWebhookRouter({} as never, deps));
  return app;
}

function subEvent(type: string, status: string): Record<string, unknown> {
  return {
    id: `evt_${uuidv4()}`,
    type,
    data: { object: { id: 'sub_1', customer: 'cus_1', status } },
  };
}

async function postSigned(app: express.Express, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(rawBody, STRIPE_SECRET))
    .set('content-type', 'application/json')
    .send(rawBody);
}

describe('Stripe auto-deprovision trigger', () => {
  const ORIGINAL = process.env.AUTO_DEPROVISION_ON_CANCEL;
  afterEach(() => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = ORIGINAL;
    vi.restoreAllMocks();
  });

  it('enqueues a deprovision job on subscription.deleted when the flag is on', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = 'true';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.deleted', 'canceled'));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      DEPROVISION_TENANT_JOB_TYPE,
      expect.objectContaining({ tenantId: TENANT, reason: 'stripe_subscription_deleted' }),
      `deprovision-${TENANT}`,
    );
  });

  it('does NOT enqueue when the flag is off', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = '';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.deleted', 'canceled'));
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT enqueue on a past_due dunning update', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = 'true';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.updated', 'past_due'));
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });
});
