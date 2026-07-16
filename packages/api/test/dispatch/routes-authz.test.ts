import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createDispatchRoutes } from '../../src/dispatch/routes';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

/**
 * SEC-22 / SEC-21 — authorization regression tests for the dispatch routes.
 *
 * SEC-22: GET /api/dispatch/technician/:id/appointments was gated only by
 * requireAuth + requireTenant, with no check that a technician-role caller
 * owned :id — any authenticated tenant member could read another
 * technician's full day (customer names, addresses, lat/long, job
 * summaries). Fixed by mirroring the gate in
 * routes/technician-location.ts:47 — owner/dispatcher may read any
 * technician; a technician-role caller may only read their own canonical id
 * (`req.auth.canonicalUserId`, resolved from the Clerk subject).
 *
 * SEC-21: GET /api/dispatch/board resolved tenant as
 * `req.auth?.tenantId ?? x-tenant-id header` — a client-controlled
 * fallback. Fixed by requiring requireAuth + requireTenant and deriving
 * tenantId exclusively from req.auth, like every sibling route in this
 * file.
 */
describe('dispatch routes — authorization', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const ownerId = '550e8400-e29b-41d4-a716-446655440010';
  const dispatcherId = '550e8400-e29b-41d4-a716-446655440011';
  const techAId = '550e8400-e29b-41d4-a716-446655440020';
  const techBId = '550e8400-e29b-41d4-a716-446655440021';
  const ownerClerkId = 'user_owner_clerk';
  const dispatcherClerkId = 'user_dispatcher_clerk';
  const techAClerkId = 'user_tech_a_clerk';
  const techBClerkId = 'user_tech_b_clerk';
  const appointmentId = '550e8400-e29b-41d4-a716-446655440030';

  let app: express.Express;
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let currentAuth: AuthenticatedRequest['auth'] | undefined;
  let enqueueEnRouteNotice: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    auditRepo = new InMemoryAuditRepository();
    currentAuth = undefined;
    enqueueEnRouteNotice = vi.fn().mockResolvedValue(`${appointmentId}:en_route`);

    // Mirrors technician-location.route.test.ts: a middleware that stamps
    // req.auth from a mutable `currentAuth` so each test can swap identity
    // without rebuilding the app. When currentAuth is undefined, req.auth
    // is left unset (simulates a caller requireAuth/requireTenant reject).
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (currentAuth) {
        (req as AuthenticatedRequest).auth = currentAuth;
      }
      next();
    });

    app.use(
      '/api/dispatch',
      createDispatchRoutes({
        appointmentRepo,
        assignmentRepo,
        enRouteCoordinator: { enqueueEnRouteNotice },
        auditRepo,
      }),
    );
  });

  describe('GET /api/dispatch/technician/:id/appointments', () => {
    it('allows an owner to read any technician\'s appointments', async () => {
      currentAuth = {
        userId: ownerClerkId,
        canonicalUserId: ownerId,
        sessionId: 's1',
        tenantId,
        role: 'owner',
      };

      const res = await request(app)
        .get(`/api/dispatch/technician/${techBId}/appointments`)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('appointments');
    });

    it('allows a dispatcher to read any technician\'s appointments', async () => {
      currentAuth = {
        userId: dispatcherClerkId,
        canonicalUserId: dispatcherId,
        sessionId: 's1',
        tenantId,
        role: 'dispatcher',
      };

      const res = await request(app)
        .get(`/api/dispatch/technician/${techBId}/appointments`)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('appointments');
    });

    it('rejects a technician-role caller reading ANOTHER technician\'s id', async () => {
      currentAuth = {
        userId: techAClerkId,
        canonicalUserId: techAId,
        sessionId: 's1',
        tenantId,
        role: 'technician',
      };

      const res = await request(app)
        .get(`/api/dispatch/technician/${techBId}/appointments`)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('allows a technician-role caller reading their OWN canonical id', async () => {
      currentAuth = {
        userId: techAClerkId,
        canonicalUserId: techAId,
        sessionId: 's1',
        tenantId,
        role: 'technician',
      };

      const res = await request(app)
        .get(`/api/dispatch/technician/${techAId}/appointments`)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('appointments');
    });

    it('fails closed when a technician has no resolved canonical id', async () => {
      currentAuth = {
        userId: techAClerkId,
        sessionId: 's1',
        tenantId,
        role: 'technician',
      };

      const res = await request(app)
        .get(`/api/dispatch/technician/${techAId}/appointments`)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('rejects an unauthenticated caller', async () => {
      currentAuth = undefined;

      const res = await request(app)
        .get(`/api/dispatch/technician/${techAId}/appointments`)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/dispatch/appointments/:id/en-route', () => {
    async function seedAssignedAppointment(technicianId: string): Promise<void> {
      const now = new Date();
      await appointmentRepo.create({
        id: appointmentId,
        tenantId,
        jobId: '550e8400-e29b-41d4-a716-446655440040',
        scheduledStart: now,
        scheduledEnd: new Date(now.getTime() + 60 * 60 * 1000),
        timezone: 'UTC',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: ownerId,
        createdAt: now,
        updatedAt: now,
      });
      await assignmentRepo.create({
        id: '550e8400-e29b-41d4-a716-446655440050',
        tenantId,
        appointmentId,
        technicianId,
        isPrimary: true,
        assignedBy: dispatcherId,
        assignedAt: now,
      });
    }

    it('allows the technician assigned by canonical users.id', async () => {
      await seedAssignedAppointment(techAId);
      currentAuth = {
        userId: techAClerkId,
        canonicalUserId: techAId,
        sessionId: 's1',
        tenantId,
        role: 'technician',
      };

      const res = await request(app)
        .post(`/api/dispatch/appointments/${appointmentId}/en-route`)
        .send({});

      expect(res.status).toBe(202);
      expect(enqueueEnRouteNotice).toHaveBeenCalledTimes(1);
      const events = auditRepo
        .getAll()
        .filter((event) => event.eventType === 'appointment.en_route_triggered');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId,
        actorId: techAClerkId,
        actorRole: 'technician',
        entityType: 'appointment',
        entityId: appointmentId,
        correlationId: `${appointmentId}:en_route`,
        metadata: {},
      });
    });

    it('rejects another technician before triggering a notification', async () => {
      await seedAssignedAppointment(techAId);
      currentAuth = {
        userId: techBClerkId,
        canonicalUserId: techBId,
        sessionId: 's1',
        tenantId,
        role: 'technician',
      };

      const res = await request(app)
        .post(`/api/dispatch/appointments/${appointmentId}/en-route`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
      expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
      expect(auditRepo.getAll()).toHaveLength(0);
    });

    it('fails closed without a canonical technician identity', async () => {
      await seedAssignedAppointment(techAId);
      currentAuth = {
        userId: techAClerkId,
        sessionId: 's1',
        tenantId,
        role: 'technician',
      };

      const res = await request(app)
        .post(`/api/dispatch/appointments/${appointmentId}/en-route`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
      expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
    });

    it('preserves dispatcher access without requiring assignment', async () => {
      await seedAssignedAppointment(techAId);
      currentAuth = {
        userId: dispatcherClerkId,
        canonicalUserId: dispatcherId,
        sessionId: 's1',
        tenantId,
        role: 'dispatcher',
      };

      const res = await request(app)
        .post(`/api/dispatch/appointments/${appointmentId}/en-route`)
        .send({});

      expect(res.status).toBe(202);
      expect(enqueueEnRouteNotice).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/dispatch/board', () => {
    it('rejects a forged x-tenant-id header with no auth tenant', async () => {
      currentAuth = undefined;

      const res = await request(app)
        .get('/api/dispatch/board')
        .set('x-tenant-id', tenantId)
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(401);
    });

    it('never falls back to x-tenant-id when req.auth carries a different tenant', async () => {
      const otherTenantId = '550e8400-e29b-41d4-a716-446655440099';
      currentAuth = {
        userId: ownerClerkId,
        canonicalUserId: ownerId,
        sessionId: 's1',
        tenantId,
        role: 'owner',
      };

      const res = await request(app)
        .get('/api/dispatch/board')
        .set('x-tenant-id', otherTenantId)
        .query({ date: '2026-07-11' });

      // Resolves from req.auth.tenantId, not the forged header — 200 with
      // an empty board for the authenticated tenant, never a cross-tenant read.
      expect(res.status).toBe(200);
    });

    it('resolves a normal authed request from req.auth', async () => {
      currentAuth = {
        userId: ownerClerkId,
        canonicalUserId: ownerId,
        sessionId: 's1',
        tenantId,
        role: 'owner',
      };

      const res = await request(app)
        .get('/api/dispatch/board')
        .query({ date: '2026-07-11' });

      expect(res.status).toBe(200);
    });
  });
});
