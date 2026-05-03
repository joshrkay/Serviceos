import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';

function buildApp(): {
  app: express.Express;
  repo: InMemoryRevenueBySourceRepository;
} {
  const repo = new InMemoryRevenueBySourceRepository();
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
  app.use('/api/reports', createReportsRouter(repo));
  return { app, repo };
}

describe('GET /api/reports/revenue-by-source', () => {
  it('returns rows from the repository under data', async () => {
    const { app, repo } = buildApp();
    repo.setRows([
      {
        source: 'web_form',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring_promo',
        leadCount: 5,
        customerCount: 3,
        invoicedCents: 500_000,
        paidCents: 420_000,
      },
      {
        source: 'referral',
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        leadCount: 2,
        customerCount: 2,
        invoicedCents: 300_000,
        paidCents: 300_000,
      },
    ]);

    const res = await request(app).get('/api/reports/revenue-by-source');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      source: 'web_form',
      utmCampaign: 'spring_promo',
      paidCents: 420_000,
    });
  });

  it('rejects malformed `from` date with 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/revenue-by-source?from=not-a-date');
    expect(res.status).toBe(400);
  });

  it('returns empty data when repository has no rows', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/revenue-by-source');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
