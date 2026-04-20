import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createTechnicianLocationRouter } from '../../src/routes/technician-location';
import { InMemoryTechnicianLocationPingRepository } from '../../src/telemetry/technician-location-ping';

describe('POST /api/technician-location', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  let app: express.Express;
  let repo: InMemoryTechnicianLocationPingRepository;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    repo = new InMemoryTechnicianLocationPingRepository();

    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'tech-1',
        sessionId: 'session-1',
        tenantId,
        role: 'technician',
      };
      next();
    });

    app.use('/api/technician-location', createTechnicianLocationRouter(repo));
  });

  it('accepts batched pings for the authenticated technician', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId: 'tech-1',
      pings: [
        {
          lat: 37.7,
          lng: -122.4,
          recordedAt: '2026-04-20T11:58:00.000Z',
          source: 'gps',
        },
        {
          lat: 37.8,
          lng: -122.5,
          recordedAt: '2026-04-20T11:59:00.000Z',
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);

    const rows = await repo.listByTechnician(tenantId, 'tech-1');
    expect(rows).toHaveLength(2);
    expect(rows[0].recordedAt.toISOString()).toBe('2026-04-20T11:59:00.000Z');
    expect(rows[1].recordedAt.toISOString()).toBe('2026-04-20T11:58:00.000Z');
  });

  it('rejects technician submissions for a different technicianId', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId: 'tech-2',
      pings: [
        {
          lat: 37.7,
          lng: -122.4,
          recordedAt: '2026-04-20T11:58:00.000Z',
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('rejects invalid ping payloads', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId: 'tech-1',
      pings: [
        {
          lat: 100,
          lng: -122.4,
          recordedAt: '2026-04-20T11:58:00.000Z',
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps tenant isolation across repositories', async () => {
    await request(app).post('/api/technician-location').send({
      technicianId: 'tech-1',
      pings: [
        {
          lat: 37.7,
          lng: -122.4,
          recordedAt: '2026-04-20T11:58:00.000Z',
          source: 'gps',
        },
      ],
    });

    const mine = await repo.listByTechnician(tenantId, 'tech-1');
    const otherTenant = await repo.listByTechnician('550e8400-e29b-41d4-a716-446655440099', 'tech-1');

    expect(mine).toHaveLength(1);
    expect(otherTenant).toHaveLength(0);
  });
});
