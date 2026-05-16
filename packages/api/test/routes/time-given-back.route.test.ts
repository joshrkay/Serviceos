import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { RepoBackedTimeGivenBackReporter } from '../../src/reports/time-given-back';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

function makeSettings(tenantId: string): TenantSettings {
  const now = new Date();
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    hourlyRateCents: 12000,
    createdAt: now,
    updatedAt: now,
  };
}

async function buildApp() {
  const revenueBySourceRepo = new InMemoryRevenueBySourceRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create(makeSettings('tenant-r1'));
  const timeGivenBackReporter = new RepoBackedTimeGivenBackReporter(
    proposalRepo,
    settingsRepo,
  );
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-r1',
      sessionId: 'session-r1',
      tenantId: 'tenant-r1',
      role: 'owner',
    };
    next();
  });
  app.use('/api/reports', createReportsRouter({ revenueBySourceRepo, timeGivenBackReporter }));
  return { app, proposalRepo };
}

describe('GET /api/reports/time-given-back', () => {
  it('returns a zeroed summary under data when there is no activity', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/reports/time-given-back');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalMinutes: 0, totalHours: 0 });
    expect(res.body.data.creditVersion).toBeDefined();
  });

  it('reflects an executed proposal in the weekly total', async () => {
    const { app, proposalRepo } = await buildApp();
    const p = createProposal({
      tenantId: 'tenant-r1',
      proposalType: 'draft_estimate',
      payload: {},
      summary: 's',
      createdBy: 'user-r1',
    });
    await proposalRepo.create(p);
    // currentWeekWindow is [now - 7d, now) — strictly less than now — so
    // executedAt must be in the past, not exactly now.
    await proposalRepo.updateStatus('tenant-r1', p.id, 'executed', {
      executedAt: new Date(Date.now() - 60_000),
    });
    const res = await request(app).get('/api/reports/time-given-back');
    expect(res.status).toBe(200);
    expect(res.body.data.receipt.proposalsHandled).toBe(1);
    expect(res.body.data.totalMinutes).toBeGreaterThan(0);
  });

  it('returns 503 when the reporter is not configured', async () => {
    const revenueBySourceRepo = new InMemoryRevenueBySourceRepository();
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'u',
        sessionId: 's',
        tenantId: 'tenant-r1',
        role: 'owner',
      };
      next();
    });
    app.use('/api/reports', createReportsRouter({ revenueBySourceRepo }));
    const res = await request(app).get('/api/reports/time-given-back');
    expect(res.status).toBe(503);
  });
});
