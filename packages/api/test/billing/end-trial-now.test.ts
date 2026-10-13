/**
 * Review of #1677, H1 — "End trial and subscribe now" sets trial_end=now:
 * Stripe invoices AND charges the card inside that one request, which can
 * run past 10 s. The call must not be cut off at the generic 10 s bound (the
 * operator would be charged and told it failed, with no audit event), and a
 * double-click or re-click must not end the trial — and charge — twice.
 */
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../src/billing/subscription';
import { createBillingRouter } from '../../src/routes/billing';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { fakePool } from './fake-pool';
import { fakeStripe } from '../helpers/fake-stripe';
import { settleWithin, settleWithinIo, useProviderClock } from '../helpers/hanging-fetch';

const TENANT = '66666666-6666-4666-8666-666666666666';

/** Stripe holding one trialing subscription; ending the trial charges the card. */
function stripeWithTrial(chargeTakesMs: number) {
  let status = 'trialing';
  const stripe = fakeStripe((call) => {
    if (call.path !== '/v1/subscriptions/sub_1') return { status: 404, body: { error: { message: 'no' } } };
    if (call.method === 'GET') return { body: { id: 'sub_1', status } };
    status = 'active'; // trial ended: first invoice finalized and paid
    return { body: { id: 'sub_1', status: 'active' }, delayMs: chargeTakesMs };
  });
  const charges = () => stripe.executedOn('POST', '/v1/subscriptions/sub_1').length;
  return { ...stripe, charges };
}

const subscriptionPool = () =>
  fakePool((sql) => (sql.includes('FROM tenants') ? { rows: [{ stripe_subscription_id: 'sub_1' }] } : { rows: [] }));

const service = () => new BillingService({ pool: subscriptionPool(), config: { apiKey: 'sk_test' } });

describe('BillingService.endTrialNow', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a slow but successful trial end (Stripe answers at 15 s) is not cut off', async () => {
    const stripe = stripeWithTrial(15_000);
    vi.stubGlobal('fetch', stripe.fetchFn);

    const outcome = await settleWithin(service().endTrialNow(TENANT), 15_000);

    expect(outcome.status).toBe('fulfilled');
    expect(stripe.charges()).toBe(1);
  });

  it('a double click ends the trial with one charge', async () => {
    const stripe = stripeWithTrial(3_000); // the charge takes 3 s
    vi.stubGlobal('fetch', stripe.fetchFn);
    const svc = service();

    const both = await settleWithin(Promise.all([svc.endTrialNow(TENANT), svc.endTrialNow(TENANT)]), 12_000);

    expect(both.status).toBe('fulfilled');
    expect(stripe.charges()).toBe(1);
  });

  it('a re-click after the trial already ended (a later key window) does not charge again', async () => {
    const stripe = stripeWithTrial(0);
    vi.stubGlobal('fetch', stripe.fetchFn);
    const svc = service();

    await settleWithin(svc.endTrialNow(TENANT), 0);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const again = await settleWithin(svc.endTrialNow(TENANT), 0);

    expect(again.status).toBe('fulfilled');
    expect(stripe.charges()).toBe(1);
  });
});

describe('POST /api/billing/end-trial-now', () => {
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a slow but successful trial end answers 200 and records tenant.trial_ended_early', async () => {
    const stripe = stripeWithTrial(15_000);
    vi.stubGlobal('fetch', stripe.fetchFn);
    const audited: Array<{ eventType: string }> = [];
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'u-1', sessionId: 's-1', tenantId: TENANT, role: 'owner' };
      next();
    });
    app.use(
      '/api/billing',
      createBillingRouter({
        billingService: service(),
        auditRepo: { create: async (e: { eventType: string }) => { audited.push(e); return e; } } as never,
      }),
    );

    const outcome = await settleWithinIo(request(app).post('/api/billing/end-trial-now').send({}).then((r) => r), 20_000);

    expect(outcome.status).toBe('fulfilled');
    expect((outcome as { value: { status: number } }).value.status).toBe(200);
    expect(audited.map((e) => e.eventType)).toEqual(['tenant.trial_ended_early']);
  });
});
