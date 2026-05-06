import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBillingRouter } from '../../src/routes/billing';
import { BillingService } from '../../src/billing/subscription';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '11111111-1111-4111-8111-111111111111';

function buildApp(opts: {
  role?: 'owner' | 'dispatcher' | 'technician';
  email?: string;
  service?: BillingService;
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
  app.use('/api/billing', createBillingRouter({ billingService: opts.service }));
  return app;
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

describe('GET /api/billing/subscription — Tier 4 Subscription (Fieldly)', () => {
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

describe('POST /api/billing/portal-session — Tier 4 Subscription (Fieldly)', () => {
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
