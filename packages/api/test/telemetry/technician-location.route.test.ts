import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createTechnicianLocationRouter } from '../../src/routes/technician-location';
import { InMemoryTechnicianLocationPingRepository } from '../../src/telemetry/technician-location-ping';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('POST /api/technician-location', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const technicianId = '550e8400-e29b-41d4-a716-446655440020';
  const otherTechnicianId = '550e8400-e29b-41d4-a716-446655440021';
  const technicianClerkId = 'user_tech_clerk';
  const firstClientPingId = '770e8400-e29b-41d4-a716-446655440001';
  const secondClientPingId = '770e8400-e29b-41d4-a716-446655440002';
  // Pings older than 24h are rejected by createTechnicianLocationPing's
  // stale-window check (DEFAULT_MAX_STALE_MS). Earlier versions of
  // this test used hardcoded 2026-04 ISO strings that rotted past the
  // window as wall-clock time advanced. Relative-to-now dates keep
  // the test deterministic against the stale-window guard.
  const RECENT_PING_ISO = new Date(Date.now() - 60_000).toISOString();
  const OLDER_PING_ISO = new Date(Date.now() - 120_000).toISOString();
  let app: express.Express;
  let repo: InMemoryTechnicianLocationPingRepository;
  let auditRepo: InMemoryAuditRepository;
  let firstPingIso: string;
  let secondPingIso: string;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    repo = new InMemoryTechnicianLocationPingRepository();
    auditRepo = new InMemoryAuditRepository();

    const now = Date.now();
    firstPingIso = new Date(now - 2 * 60 * 1000).toISOString();
    secondPingIso = new Date(now - 1 * 60 * 1000).toISOString();

    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: technicianClerkId,
        canonicalUserId: technicianId,
        sessionId: 'session-1',
        tenantId,
        role: 'technician',
      };
      next();
    });

    app.use(
      '/api/technician-location',
      createTechnicianLocationRouter({ repository: repo, auditRepo }),
    );
  });

  it('accepts batched pings for the technician canonical users.id', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId,
      pings: [
        {
          clientPingId: firstClientPingId,
          lat: 37.7,
          lng: -122.4,
          recordedAt: firstPingIso,
          source: 'gps',
        },
        {
          clientPingId: secondClientPingId,
          lat: 37.8,
          lng: -122.5,
          recordedAt: secondPingIso,
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.acceptedCount).toBe(2);
    expect(res.body.duplicateCount).toBe(0);

    const rows = await repo.listByTechnician(tenantId, technicianId);
    expect(rows).toHaveLength(2);
    expect(rows[0].recordedAt.toISOString()).toBe(secondPingIso);
    expect(rows[1].recordedAt.toISOString()).toBe(firstPingIso);
  });

  it('returns accepted and duplicate counts when the same batch is retried', async () => {
    const payload = {
      technicianId,
      pings: [{
        clientPingId: firstClientPingId,
        lat: 37.7,
        lng: -122.4,
        recordedAt: firstPingIso,
        source: 'gps',
      }],
    };

    const first = await request(app).post('/api/technician-location').send(payload);
    const retry = await request(app).post('/api/technician-location').send(payload);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ count: 1, acceptedCount: 1, duplicateCount: 0 });
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ count: 0, acceptedCount: 0, duplicateCount: 1 });
    await expect(repo.listByTechnician(tenantId, technicianId)).resolves.toHaveLength(1);
  });

  it('emits one location-safe audit event per successful batch attempt', async () => {
    const payload = {
      technicianId,
      pings: [{
        clientPingId: firstClientPingId,
        lat: 37.712345,
        lng: -122.412345,
        recordedAt: firstPingIso,
        source: 'gps',
      }],
    };

    await request(app).post('/api/technician-location').send(payload);
    await request(app).post('/api/technician-location').send(payload);

    const events = auditRepo
      .getAll()
      .filter((event) => event.eventType === 'technician_location.batch_ingested');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tenantId,
      actorId: technicianClerkId,
      actorRole: 'technician',
      entityType: 'technician',
      entityId: technicianId,
      metadata: { submittedCount: 1, acceptedCount: 1, duplicateCount: 0 },
    });
    expect(events[1].metadata).toEqual({
      submittedCount: 1,
      acceptedCount: 0,
      duplicateCount: 1,
    });
    expect(JSON.stringify(events)).not.toContain('37.712345');
    expect(JSON.stringify(events)).not.toContain('-122.412345');
  });

  it('requires a UUID clientPingId for every ping', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId,
      pings: [{
        lat: 37.7,
        lng: -122.4,
        recordedAt: firstPingIso,
        source: 'gps',
      }],
    });

    expect(res.status).toBe(400);
    expect(await repo.listByTechnician(tenantId, technicianId)).toHaveLength(0);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('rejects technician submissions for a different technicianId', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId: otherTechnicianId,
      pings: [
        {
          clientPingId: firstClientPingId,
          lat: 37.7,
          lng: -122.4,
          recordedAt: firstPingIso,
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('fails closed when the technician canonical identity is unavailable', async () => {
    app = express();
    app.use(express.json());
    repo = new InMemoryTechnicianLocationPingRepository();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: technicianClerkId,
        sessionId: 'session-1',
        tenantId,
        role: 'technician',
      };
      next();
    });
    app.use(
      '/api/technician-location',
      createTechnicianLocationRouter({ repository: repo, auditRepo }),
    );

    const res = await request(app).post('/api/technician-location').send({
      technicianId,
      pings: [{
        clientPingId: firstClientPingId,
        lat: 37.7,
        lng: -122.4,
        recordedAt: firstPingIso,
        source: 'gps',
      }],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(await repo.listByTechnician(tenantId, technicianId)).toHaveLength(0);
  });


  it('rejects dispatcher submissions when authz check disallows target technician', async () => {
    app = express();
    app.use(express.json());
    repo = new InMemoryTechnicianLocationPingRepository();

    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user_dispatcher_clerk',
        canonicalUserId: '550e8400-e29b-41d4-a716-446655440011',
        sessionId: 'session-1',
        tenantId,
        role: 'dispatcher',
      };
      next();
    });

    app.use(
      '/api/technician-location',
      createTechnicianLocationRouter({
        repository: repo,
        canSubmitForTechnician: async () => false,
        auditRepo,
      })
    );

    const res = await request(app).post('/api/technician-location').send({
      technicianId,
      pings: [
        {
          clientPingId: firstClientPingId,
          lat: 37.7,
          lng: -122.4,
          recordedAt: RECENT_PING_ISO,
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('rejects invalid ping payloads', async () => {
    const res = await request(app).post('/api/technician-location').send({
      technicianId,
      pings: [
        {
          clientPingId: firstClientPingId,
          lat: 100,
          lng: -122.4,
          recordedAt: firstPingIso,
          source: 'gps',
        },
      ],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps tenant isolation across repositories', async () => {
    await request(app).post('/api/technician-location').send({
      technicianId,
      pings: [
        {
          clientPingId: firstClientPingId,
          lat: 37.7,
          lng: -122.4,
          recordedAt: firstPingIso,
          source: 'gps',
        },
      ],
    });

    const mine = await repo.listByTechnician(tenantId, technicianId);
    const otherTenant = await repo.listByTechnician(
      '550e8400-e29b-41d4-a716-446655440099',
      technicianId,
    );

    expect(mine).toHaveLength(1);
    expect(otherTenant).toHaveLength(0);
  });
});
