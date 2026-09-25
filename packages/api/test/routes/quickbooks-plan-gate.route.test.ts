/**
 * QuickBooks sync is a Growth feature. Connecting and manual sync are refused
 * for Starter (and for a tenant with no plan yet) with an upgrade message;
 * Growth behaves as before.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createIntegrationsRouter, type IntegrationsRouteDeps } from '../../src/routes/integrations';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { toErrorResponse } from '../../src/shared/errors';
import type { CallPlanId } from '../../src/billing/call-usage-pricing';

const TENANT = '11111111-1111-4111-8111-111111111111';

function buildApp(planId: CallPlanId | null) {
  const deps = {
    integrationRepo: { findByTenant: vi.fn(async () => null) },
    syncLogRepo: {},
    oauthStateRepo: { create: vi.fn(async () => ({ id: 'state-1' })) },
    invoiceRepo: {},
    customerRepo: {},
    jobRepo: {},
    qboConfig: {
      clientId: 'qbo-client',
      clientSecret: 'qbo-secret',
      redirectUri: 'https://api.test/api/integrations/quickbooks/callback',
      environment: 'sandbox',
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    planForTenant: vi.fn(async () => planId),
  } as unknown as IntegrationsRouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-owner',
      sessionId: 'sess',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/integrations', createIntegrationsRouter(deps));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  });
  return { app, deps };
}

describe('QuickBooks is Growth-only', () => {
  it('lets a Growth tenant start the QuickBooks connection', async () => {
    const { app } = buildApp('growth');
    const res = await request(app).post('/api/integrations/quickbooks/connect').send({});
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/intuit|appcenter/i);
  });

  it('refuses Starter (and a tenant with no plan yet) with an upgrade message, before any OAuth state', async () => {
    for (const planId of ['starter', null] as const) {
      const { app, deps } = buildApp(planId);
      const res = await request(app).post('/api/integrations/quickbooks/connect').send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: 'PLAN_UPGRADE_REQUIRED',
        message: 'QuickBooks sync is part of Growth. Upgrade to connect your Intuit account.',
      });
      expect(deps.oauthStateRepo.create).not.toHaveBeenCalled();
    }
  });

  it('refuses a manual sync for a tenant no longer on Growth', async () => {
    const { app } = buildApp('starter');
    const res = await request(app).post('/api/integrations/quickbooks/sync').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PLAN_UPGRADE_REQUIRED');
  });
});
