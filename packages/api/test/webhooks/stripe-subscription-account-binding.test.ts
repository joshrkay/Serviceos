/**
 * Stripe `customer.subscription.*` — Rivet's own subscriptions (trial
 * checkout, billing portal) are created on the PLATFORM account
 * (billing/subscription.ts sends no Stripe-Account header), so a genuine
 * event for one never carries a top-level `event.account`. An event that
 * does was delivered from a connected account: its `metadata.tenant_id` and
 * `customer` are whatever that account wrote, so mirroring it would let it
 * claim a Stripe customer for, and set the subscription status and plan of,
 * the tenant it names.
 *
 * The branch now refuses such an event through the #1102 refusal path
 * (403, `webhook.auth_failed` audit on the named tenant, webhook row left
 * 'failed') BEFORE any tenant read or write, queue job or BillingService
 * call. Platform-origin events are unchanged.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature, InMemoryWebhookRepository } from '../../src/webhooks/webhook-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const STRIPE_SECRET = 'whsec_test_sub_account_binding';
const NAMED_TENANT = '44444444-4444-4444-8444-444444444444';

function buildApp(opts: { withPool: boolean }) {
  const queryMock = vi.fn(async () => ({ rowCount: 1, rows: [{ id: NAMED_TENANT }] }));
  const connect = vi.fn(async () => ({ query: queryMock, release: vi.fn() }));
  const send = vi.fn(async () => 'job-1');
  const applySubscriptionEvent = vi.fn(async () => undefined);
  const auditRepo = new InMemoryAuditRepository();
  const webhookRepo = new InMemoryWebhookRepository();
  const deps = {
    billingService: { applySubscriptionEvent } as never,
    ...(opts.withPool ? { pool: { query: queryMock, connect } as never } : {}),
    queue: { send } as never,
    auditRepo,
    webhookRepo,
    stripeWebhookSecret: STRIPE_SECRET,
  };
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use('/webhooks', createWebhookRouter({} as never, deps));
  return { app, queryMock, connect, send, applySubscriptionEvent, auditRepo, webhookRepo };
}

function subEvent(
  type: string,
  opts: { account?: string; tenantId?: string; status?: string } = {},
): Record<string, unknown> {
  return {
    id: `evt_${uuidv4()}`,
    type,
    ...(opts.account !== undefined ? { account: opts.account } : {}),
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status: opts.status ?? 'active',
        ...(opts.tenantId ? { metadata: { tenant_id: opts.tenantId } } : {}),
      },
    },
  };
}

function postSigned(app: express.Express, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(rawBody, STRIPE_SECRET))
    .set('content-type', 'application/json')
    .send(rawBody);
}

describe('Stripe customer.subscription.* — connected-account events are refused', () => {
  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])('%s carrying event.account + metadata.tenant_id touches nothing', async (type) => {
    const h = buildApp({ withPool: true });
    const res = await postSigned(
      h.app,
      subEvent(type, { account: 'acct_other', tenantId: NAMED_TENANT, status: 'canceled' }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', reason: 'stripe_subscription_not_platform' });
    // No tenant read/write, no checkout, no queue job (provision / release / deprovision).
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.applySubscriptionEvent).not.toHaveBeenCalled();

    // The named tenant can see the attempt.
    const audits = await h.auditRepo.findByEntity(
      NAMED_TENANT,
      'webhook',
      'stripe_subscription_not_platform',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ eventType: 'webhook.auth_failed', actorId: 'system:stripe_webhook' });
    expect(audits[0].metadata).toMatchObject({ eventAccount: 'acct_other', stripeEventType: type });
  });

  it('refuses a connected-account event that names no tenant (customer-mapped path) without auditing', async () => {
    const h = buildApp({ withPool: true });
    const res = await postSigned(h.app, subEvent('customer.subscription.updated', { account: 'acct_other' }));
    expect(res.status).toBe(403);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('refuses on the no-pool path too (BillingService.applySubscriptionEvent is not called)', async () => {
    const h = buildApp({ withPool: false });
    const res = await postSigned(
      h.app,
      subEvent('customer.subscription.updated', { account: 'acct_other', tenantId: NAMED_TENANT }),
    );
    expect(res.status).toBe(403);
    expect(h.applySubscriptionEvent).not.toHaveBeenCalled();
  });

  it('a platform-origin event (no event.account) is still mirrored', async () => {
    const h = buildApp({ withPool: true });
    const res = await postSigned(
      h.app,
      subEvent('customer.subscription.updated', { tenantId: NAMED_TENANT, status: 'active' }),
    );
    expect(res.status).toBe(200);
    expect(h.connect).toHaveBeenCalledTimes(1);
    const sql = h.queryMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(sql.some((s) => /SET stripe_subscription_id = \$1/.test(s))).toBe(true);
  });

  it('a blank event.account is treated as platform-origin', async () => {
    const h = buildApp({ withPool: true });
    const res = await postSigned(
      h.app,
      subEvent('customer.subscription.updated', { account: '  ', tenantId: NAMED_TENANT }),
    );
    expect(res.status).toBe(200);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
});
