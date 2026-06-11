import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBillingRouter } from '../../src/routes/billing';
import { BillingService } from '../../src/billing/subscription';
import { StripeConnectService } from '../../src/billing/stripe-connect';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '11111111-1111-4111-8111-111111111111';

function buildApp(opts: {
  role?: 'owner' | 'dispatcher' | 'technician';
  email?: string;
  service?: BillingService;
  connectService?: StripeConnectService;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const r = req as AuthenticatedRequest;
    r.auth = {
      userId: 'user-test',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: opts.role ?? 'owner',
    };
    if (opts.email !== undefined) {
      r.clerkUser = {
        id: 'user-test',
        email: opts.email,
      };
    }
    next();
  });
  app.use(
    '/api/billing',
    createBillingRouter({
      billingService: opts.service,
      connectService: opts.connectService,
    }),
  );
  return app;
}

function makeConnectService(overrides: Partial<StripeConnectService> = {}): StripeConnectService {
  return {
    getAccount: vi.fn(async () => ({
      accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false,
    })),
    createOnboardingLink: vi.fn(async () => ({
      url: 'https://connect.stripe.com/setup/acct_test',
      accountId: 'acct_test',
    })),
    applyAccountUpdated: vi.fn(),
    disconnect: vi.fn(async () => true),
    ...overrides,
  } as unknown as StripeConnectService;
}

function makeService(overrides: Partial<BillingService> = {}): BillingService {
  return {
    getSubscription: vi.fn(async () => ({
      customerId: 'cus_test',
      subscriptionId: 'sub_test',
      status: 'active',
    })),
    getOrCreatePortalUrl: vi.fn(async () => ({
      url: 'https://billing.stripe.com/p/test_session',
    })),
    applySubscriptionEvent: vi.fn(),
    ...overrides,
  } as unknown as BillingService;
}

describe('GET /api/billing/subscription — Tier 4 Subscription (Rivet)', () => {
  it('returns the cached subscription view when service is wired', async () => {
    const service = makeService();
    const app = buildApp({ service });
    const res = await request(app).get('/api/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customerId: 'cus_test',
      subscriptionId: 'sub_test',
      status: 'active',
    });
  });

  it('returns null fields when service is NOT wired (legacy harness)', async () => {
    const app = buildApp({});
    const res = await request(app).get('/api/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customerId: null, subscriptionId: null, status: null });
  });

  it('technicians without settings:view get 403', async () => {
    const app = buildApp({ role: 'technician', service: makeService() });
    const res = await request(app).get('/api/billing/subscription');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/billing/portal-session — Tier 4 Subscription (Rivet)', () => {
  let service: BillingService;
  beforeEach(() => {
    service = makeService();
  });

  it('returns the Stripe portal URL for an owner', async () => {
    const app = buildApp({ service, email: 'owner@example.com' });
    const res = await request(app)
      .post('/api/billing/portal-session')
      .send({ returnUrl: 'https://app.example.com/settings' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://billing.stripe.com/p/test_session');
    expect(service.getOrCreatePortalUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        ownerEmail: 'owner@example.com',
        returnUrl: 'https://app.example.com/settings',
      }),
    );
  });

  it('rejects dispatchers (tenant:manage owner-only)', async () => {
    const app = buildApp({ service, role: 'dispatcher', email: 'd@example.com' });
    const res = await request(app)
      .post('/api/billing/portal-session')
      .send({ returnUrl: 'https://app.example.com/settings' });
    expect(res.status).toBe(403);
  });

  it('rejects malformed returnUrl with 400', async () => {
    const app = buildApp({ service, email: 'owner@example.com' });
    const res = await request(app)
      .post('/api/billing/portal-session')
      .send({ returnUrl: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the auth context has no email', async () => {
    const app = buildApp({ service /* no email */ });
    const res = await request(app)
      .post('/api/billing/portal-session')
      .send({ returnUrl: 'https://app.example.com/settings' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when the service is not wired', async () => {
    const app = buildApp({ email: 'owner@example.com' });
    const res = await request(app)
      .post('/api/billing/portal-session')
      .send({ returnUrl: 'https://app.example.com/settings' });
    expect(res.status).toBe(503);
  });
});

describe('Stripe Connect routes — Tier 4 Payment methods (PR 1)', () => {
  it('GET /connect returns null fields when service not wired', async () => {
    const app = buildApp({});
    const res = await request(app).get('/api/billing/connect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false,
    });
  });

  it('GET /connect returns the cached view when service is wired', async () => {
    const connectService = makeConnectService({
      getAccount: vi.fn(async () => ({
        accountId: 'acct_x', status: 'active', chargesEnabled: true, payoutsEnabled: true,
      })),
    } as Partial<StripeConnectService>);
    const app = buildApp({ connectService });
    const res = await request(app).get('/api/billing/connect');
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe('acct_x');
    expect(res.body.status).toBe('active');
  });

  it('POST /connect/onboarding returns the onboarding URL', async () => {
    const connectService = makeConnectService();
    const app = buildApp({ connectService, email: 'owner@example.com' });
    const res = await request(app)
      .post('/api/billing/connect/onboarding')
      .send({
        returnUrl: 'https://app.example.com/settings',
        refreshUrl: 'https://app.example.com/settings',
      });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('connect.stripe.com');
    expect(res.body.accountId).toBe('acct_test');
  });

  it('POST /connect/onboarding rejects bad URL inputs at the schema layer', async () => {
    const connectService = makeConnectService();
    const app = buildApp({ connectService, email: 'owner@example.com' });
    const res = await request(app)
      .post('/api/billing/connect/onboarding')
      .send({ returnUrl: 'not-a-url', refreshUrl: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('POST /connect/onboarding requires owner role (tenant:manage)', async () => {
    const connectService = makeConnectService();
    const app = buildApp({ connectService, role: 'dispatcher', email: 'd@example.com' });
    const res = await request(app)
      .post('/api/billing/connect/onboarding')
      .send({
        returnUrl: 'https://app.example.com/settings',
        refreshUrl: 'https://app.example.com/settings',
      });
    expect(res.status).toBe(403);
  });

  it('POST /connect/onboarding returns 503 when service not wired', async () => {
    const app = buildApp({ email: 'owner@example.com' });
    const res = await request(app)
      .post('/api/billing/connect/onboarding')
      .send({
        returnUrl: 'https://app.example.com/settings',
        refreshUrl: 'https://app.example.com/settings',
      });
    expect(res.status).toBe(503);
  });

  it('POST /connect/onboarding returns 400 when no owner email on auth context', async () => {
    const connectService = makeConnectService();
    const app = buildApp({ connectService /* no email */ });
    const res = await request(app)
      .post('/api/billing/connect/onboarding')
      .send({
        returnUrl: 'https://app.example.com/settings',
        refreshUrl: 'https://app.example.com/settings',
      });
    expect(res.status).toBe(400);
  });

  it('DELETE /connect disconnects', async () => {
    const connectService = makeConnectService();
    const app = buildApp({ connectService });
    const res = await request(app).delete('/api/billing/connect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true });
  });

  it('DELETE /connect requires owner role', async () => {
    const connectService = makeConnectService();
    const app = buildApp({ connectService, role: 'dispatcher' });
    const res = await request(app).delete('/api/billing/connect');
    expect(res.status).toBe(403);
  });
});
