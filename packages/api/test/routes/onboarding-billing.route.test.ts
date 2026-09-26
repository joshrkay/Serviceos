import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { __setClientForTests, __resetAnalyticsForTests } from '../../src/analytics/posthog';
import { BillingService } from '../../src/billing/subscription';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryPackActivationRepository } from '../../src/settings/pack-activation';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';

/**
 * Route-level coverage for GET /api/onboarding/billing/plans and
 * POST /api/onboarding/billing/checkout-session — the explicit
 * starter/growth plan selection surface. BillingService's Stripe calls
 * are stubbed via its injectable `fetchFn`; the tenant Pool is stubbed
 * directly (BillingService's own unit tests exercise the SQL shapes).
 */

const TENANT_ID = 'tenant-billing-1';
const USER_ID = 'user-billing-1';

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
function jsonErr(status: number, body: unknown) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function validPrice(overrides: Record<string, unknown> = {}) {
  return jsonOk({
    active: true,
    currency: 'usd',
    type: 'recurring',
    unit_amount: 7_900,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: 'prod_starter', active: true, name: 'Rivet Starter' },
    ...overrides,
  });
}

/** Minimal Pool stub: canonical customer already exists, no active sub, no pending checkout. */
function fakePool(): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('SELECT subscription_status, pending_checkout_at')) {
      return { rows: [{ subscription_status: null, pending_checkout_at: null }] };
    }
    if (sql.includes('SELECT stripe_customer_id')) return { rows: [{ stripe_customer_id: 'cus_existing' }] };
    return { rows: [] };
  });
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as unknown as Pool;
}

function buildApp(billingService?: BillingService, role: string = 'owner') {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-billing-1',
      tenantId: TENANT_ID,
      role: role as NonNullable<AuthenticatedRequest['auth']>['role'],
    };
    (req as AuthenticatedRequest).clerkUser = { id: USER_ID, email: 'owner@example.com' };
    next();
  });
  app.use(
    '/api/onboarding',
    createOnboardingRouter({
      settingsRepo: new InMemorySettingsRepository(),
      packActivationRepo: new InMemoryPackActivationRepository(),
      auditRepo: new InMemoryAuditRepository(),
      pool: undefined,
      billingService,
    }),
  );
  return app;
}

describe('GET /api/onboarding/billing/plans', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_STARTER_PRICE_ID', 'price_starter_live');
    vi.stubEnv('STRIPE_GROWTH_PRICE_ID', 'price_growth_live');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 503 when billing is not configured', async () => {
    const res = await request(buildApp(undefined)).get('/api/onboarding/billing/plans');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('BILLING_NOT_CONFIGURED');
  });

  it('returns validated plans with no price ids in the response', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(validPrice({ unit_amount: 7_900, product: { id: 'prod_starter', active: true, name: 'Rivet Starter' } }))
      .mockResolvedValueOnce(
        validPrice({ unit_amount: 19_900, product: { id: 'prod_growth', active: true, name: 'Rivet Growth' } }),
      );
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await request(buildApp(svc)).get('/api/onboarding/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans).toEqual([
      {
        id: 'starter', name: 'Rivet Starter', amountCents: 7_900, currency: 'usd', interval: 'month',
        includedUsers: 2, includedAiMinutes: 20, overageCentsPerAiMinute: 125,
      },
      {
        id: 'growth', name: 'Rivet Growth', amountCents: 19_900, currency: 'usd', interval: 'month',
        includedUsers: 5, includedAiMinutes: 60, overageCentsPerAiMinute: 125,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/price_(starter|growth)_live/);
  });

  it('fails closed with a 503 + actionable message when nothing validates', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValue(jsonErr(404, { error: { message: 'No such price' } }));
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await request(buildApp(svc)).get('/api/onboarding/billing/plans');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('BILLING_PLANS_UNAVAILABLE');
    expect(res.body.message).not.toMatch(/sk_test|price_/);
    errorSpy.mockRestore();
  });
});

describe('POST /api/onboarding/billing/checkout-session', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_STARTER_PRICE_ID', 'price_starter_live');
    vi.stubEnv('STRIPE_GROWTH_PRICE_ID', 'price_growth_live');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('400s with no fallback when planId is missing', async () => {
    const fetchFn = vi.fn();
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });
    const res = await request(buildApp(svc)).post('/api/onboarding/billing/checkout-session').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('400s for the retired basic/enterprise plan ids, even with their old price env set', async () => {
    vi.stubEnv('STRIPE_BASIC_PRICE_ID', 'price_basic_live');
    vi.stubEnv('STRIPE_ENTERPRISE_PRICE_ID', 'price_enterprise_live');
    const fetchFn = vi.fn();
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });
    for (const planId of ['basic', 'enterprise']) {
      const res = await request(buildApp(svc))
        .post('/api/onboarding/billing/checkout-session')
        .send({ planId });
      expect(res.status).toBe(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('400s with no fallback when planId is not in the allowlist', async () => {
    const fetchFn = vi.fn();
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });
    const res = await request(buildApp(svc))
      .post('/api/onboarding/billing/checkout-session')
      .send({ planId: 'premium' });
    expect(res.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('mints a checkout session for an explicit, validated plan and stamps plan_id metadata', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(validPrice({ unit_amount: 7_900 }))
      .mockResolvedValueOnce(jsonOk({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }));
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await request(buildApp(svc))
      .post('/api/onboarding/billing/checkout-session')
      .send({ planId: 'starter' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://api.stripe.com/v1/prices/price_starter_live?expand[]=product',
    );
    const body = fetchFn.mock.calls[1][1].body as URLSearchParams;
    expect(body.get('subscription_data[metadata][plan_id]')).toBe('starter');
  });

  it('records a plan_selected funnel event for the chosen plan', async () => {
    const capture = vi.fn();
    process.env.POSTHOG_API_KEY = 'phc_test';
    __setClientForTests({ capture, groupIdentify: vi.fn(), shutdown: vi.fn() } as never);
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          validPrice({ unit_amount: 19_900, product: { id: 'prod_growth', active: true, name: 'Rivet Growth' } }),
        )
        .mockResolvedValueOnce(jsonOk({ id: 'cs_growth', url: 'https://checkout.stripe.com/c/pay/cs_growth' }));
      const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });

      const res = await request(buildApp(svc))
        .post('/api/onboarding/billing/checkout-session')
        .send({ planId: 'growth' });

      expect(res.status).toBe(200);
      expect(capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: USER_ID,
          event: 'plan_selected',
          properties: expect.objectContaining({ tenant_id: TENANT_ID, plan: 'growth' }),
        }),
      );
    } finally {
      __resetAnalyticsForTests();
      delete process.env.POSTHOG_API_KEY;
    }
  });

  it('builds the Stripe success and cancel URLs from config.publicOrigins.web, not raw env', async () => {
    // The route used to read WEB_URL ?? APP_PUBLIC_URL straight from
    // process.env with a localhost fallback. The origin now comes from the
    // config seam, so a deployment whose config resolves the web origin
    // returns the customer to the app domain regardless of what process.env
    // happens to hold.
    const { loadConfig, resetConfig } = await import('../../src/shared/config');
    resetConfig();
    loadConfig({ NODE_ENV: 'dev', WEB_URL: 'https://app.example.com' });
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(validPrice({ unit_amount: 7_900 }))
        .mockResolvedValueOnce(jsonOk({ id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' }));
      const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });

      const res = await request(buildApp(svc))
        .post('/api/onboarding/billing/checkout-session')
        .send({ planId: 'starter' });
      expect(res.status).toBe(200);
      const body = fetchFn.mock.calls[1][1].body as URLSearchParams;
      expect(body.get('success_url')).toBe('https://app.example.com/onboarding?billing=ok');
      expect(body.get('cancel_url')).toBe('https://app.example.com/onboarding?billing=cancel');
    } finally {
      resetConfig();
    }
  });

  it('surfaces a misconfigured plan as an actionable 400/500 without charging', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValueOnce(validPrice({ unit_amount: 1 }));
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });

    const res = await request(buildApp(svc))
      .post('/api/onboarding/billing/checkout-session')
      .send({ planId: 'starter' });
    expect(res.status).toBeLessThan(500);
    expect(res.body.message).toMatch(/misconfigured/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('requires the owner role', async () => {
    const fetchFn = vi.fn();
    const svc = new BillingService({ pool: fakePool(), config: { apiKey: 'sk_test' }, fetchFn: fetchFn as unknown as typeof fetch });
    const res = await request(buildApp(svc, 'technician'))
      .post('/api/onboarding/billing/checkout-session')
      .send({ planId: 'starter' });
    expect(res.status).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
