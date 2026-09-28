/**
 * Stripe `customer.subscription.*` Twilio lifecycle trigger in
 * src/webhooks/routes.ts. The Twilio number is a real recurring cost, so it is
 * only provisioned AFTER trial checkout (card on file) — when the
 * subscription goes `trialing`/`active` — and the number is released on a true
 * cancellation (deleted event or status 'canceled').
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { PROVISION_TWILIO_JOB_TYPE } from '../../src/workers/provision-twilio';
import { RELEASE_TWILIO_NUMBER_JOB_TYPE } from '../../src/workers/release-twilio-number';

const STRIPE_SECRET = 'whsec_test_sub_twilio';
const TENANT = '33333333-3333-3333-3333-333333333333';

function buildApp(send: ReturnType<typeof vi.fn>) {
  const queryMock = vi.fn(async () => ({ rowCount: 1, rows: [{ id: TENANT }] }));
  const pool = {
    query: queryMock,
    connect: vi.fn(async () => ({
      query: queryMock,
      release: vi.fn(),
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

function provisionCalls(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter((c) => c[0] === PROVISION_TWILIO_JOB_TYPE);
}

function releaseCalls(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter((c) => c[0] === RELEASE_TWILIO_NUMBER_JOB_TYPE);
}

describe('Stripe subscription Twilio lifecycle trigger', () => {
  const ORIGINAL = process.env.AUTO_DEPROVISION_ON_CANCEL;
  afterEach(() => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = ORIGINAL;
    vi.restoreAllMocks();
  });

  it('enqueues Twilio provisioning on subscription.created with status trialing (trial checkout)', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = '';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.created', 'trialing'));
    expect(res.status).toBe(200);
    const calls = provisionCalls(send);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({ tenantId: TENANT }),
    );
    expect(calls[0][2]).toBe(`provision-twilio-${TENANT}`);
    expect(releaseCalls(send)).toHaveLength(0);
  });

  it('enqueues Twilio provisioning on subscription.updated to active (deduped by stable key)', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = '';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const first = await postSigned(app, subEvent('customer.subscription.created', 'trialing'));
    expect(first.status).toBe(200);
    const second = await postSigned(app, subEvent('customer.subscription.updated', 'active'));
    expect(second.status).toBe(200);
    // One logical enqueue per distinct event; both share the stable
    // idempotency key so the production queue collapses duplicates.
    expect(provisionCalls(send)).toHaveLength(2);
    for (const call of provisionCalls(send)) {
      expect(call[2]).toBe(`provision-twilio-${TENANT}`);
    }
    expect(releaseCalls(send)).toHaveLength(0);
  });

  it('enqueues a number-release job on subscription.updated with status canceled (not gated by AUTO_DEPROVISION_ON_CANCEL)', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = '';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.updated', 'canceled'));
    expect(res.status).toBe(200);
    const calls = releaseCalls(send);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({ tenantId: TENANT, reason: 'stripe_subscription_canceled' }),
    );
    expect(calls[0][2]).toBe(`release-twilio-${TENANT}`);
    expect(provisionCalls(send)).toHaveLength(0);
  });

  it('enqueues a number-release job on subscription.deleted (trial that never converted)', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = '';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.deleted', 'canceled'));
    expect(res.status).toBe(200);
    const calls = releaseCalls(send);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({ tenantId: TENANT, reason: 'stripe_subscription_deleted' }),
    );
    expect(provisionCalls(send)).toHaveLength(0);
  });

  it('does NOT enqueue provisioning or release on past_due dunning updates', async () => {
    process.env.AUTO_DEPROVISION_ON_CANCEL = '';
    const send = vi.fn(async () => 'job-1');
    const app = buildApp(send);
    const res = await postSigned(app, subEvent('customer.subscription.updated', 'past_due'));
    expect(res.status).toBe(200);
    expect(provisionCalls(send)).toHaveLength(0);
    expect(releaseCalls(send)).toHaveLength(0);
  });
});
