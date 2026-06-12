import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createDigestsRouter } from '../../src/routes/digests';
import {
  InMemoryDailyDigestRepository,
  type DailyDigestPayload,
} from '../../src/digest/digest-service';

function samplePayload(date: string): DailyDigestPayload {
  return {
    date,
    timezone: 'America/New_York',
    revenueCents: 125_00,
    grossRevenueCents: 130_00,
    refundsCents: 5_00,
    paymentsCount: 3,
    jobsCompletedCount: 2,
    tomorrow: { appointmentCount: 1, firstStartIso: '2026-06-12T13:00:00.000Z' },
    pendingApprovals: { totalCount: 1, top: [] },
    overdueInvoicesCount: 0,
    unbilledJobs: [],
  };
}

function buildApp(): {
  app: express.Express;
  repo: InMemoryDailyDigestRepository;
} {
  const repo = new InMemoryDailyDigestRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-d1',
      sessionId: 'session-d1',
      tenantId: 'tenant-d1',
      role: 'owner',
    };
    next();
  });
  app.use('/api/digests', createDigestsRouter({ digestRepo: repo }));
  return { app, repo };
}

describe('GET /api/digests/:date', () => {
  it('returns the stored digest for an explicit date under data', async () => {
    const { app, repo } = buildApp();
    await repo.upsert('tenant-d1', '2026-06-10', samplePayload('2026-06-10'), 'A solid day.');

    const res = await request(app).get('/api/digests/2026-06-10');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      date: '2026-06-10',
      narrative: 'A solid day.',
    });
    expect(res.body.data.payload.revenueCents).toBe(125_00);
    expect(typeof res.body.data.generatedAt).toBe('string');
  });

  it('returns the most recent digest for `latest`', async () => {
    const { app, repo } = buildApp();
    await repo.upsert('tenant-d1', '2026-06-08', samplePayload('2026-06-08'), 'older');
    await repo.upsert('tenant-d1', '2026-06-10', samplePayload('2026-06-10'), 'newest');

    const res = await request(app).get('/api/digests/latest');

    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe('2026-06-10');
    expect(res.body.data.narrative).toBe('newest');
  });

  it('404s when no digest exists for the date', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/digests/2026-06-10');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('404s for `latest` when the tenant has no digests', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/digests/latest');
    expect(res.status).toBe(404);
  });

  it('400s on a malformed date param', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/digests/2026-13-99x');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('400s on a calendar-invalid date (month 13, day 99)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/digests/2026-13-99');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('does not leak another tenant’s digest', async () => {
    const { app, repo } = buildApp();
    await repo.upsert('tenant-OTHER', '2026-06-10', samplePayload('2026-06-10'), 'theirs');
    const res = await request(app).get('/api/digests/2026-06-10');
    expect(res.status).toBe(404);
  });

  it('serializes a null narrative when none was stored', async () => {
    const { app, repo } = buildApp();
    await repo.upsert('tenant-d1', '2026-06-10', samplePayload('2026-06-10'));
    const res = await request(app).get('/api/digests/2026-06-10');
    expect(res.status).toBe(200);
    expect(res.body.data.narrative).toBeNull();
  });
});
