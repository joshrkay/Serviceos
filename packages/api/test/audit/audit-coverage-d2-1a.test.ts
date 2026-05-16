/**
 * D2-1a smoke test — verifies that the four canary mutations on the
 * appointments / locations / notes / conversations routes emit audit
 * events through the injected AuditRepository.
 *
 * Each route is wired with in-memory repos and a fake auth middleware,
 * then a single mutation is invoked. The test asserts the expected
 * event type lands in the InMemoryAuditRepository.
 */
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction, Express } from 'express';

import { createAppointmentRouter } from '../../src/routes/appointments';
import { createLocationRouter } from '../../src/routes/locations';
import { createNoteRouter } from '../../src/routes/notes';
import { createConversationRouter } from '../../src/routes/conversations';

import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryLocationRepository, createLocation } from '../../src/locations/location';
import { InMemoryNoteRepository } from '../../src/notes/note';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../src/audit/audit';

import { AuthenticatedRequest } from '../../src/auth/clerk';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';

const TENANT_ID = 'tenant-d2-1a';
const USER_ID = 'user-d2-1a';

function withAuth(app: Express): Express {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-d2-1a',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  return app;
}

describe('D2-1a — audit coverage for appointments/locations/notes/conversations', () => {
  it('POST /api/appointments writes appointment.created audit event', async () => {
    const app = express();
    app.use(express.json());
    withAuth(app);

    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const timelineRepo = new InMemoryJobTimelineRepository();
    const auditRepo = new InMemoryAuditRepository();
    const ownership = permissiveTenantOwnership();

    app.use(
      '/api/appointments',
      createAppointmentRouter(appointmentRepo, ownership, jobRepo, timelineRepo, undefined, auditRepo),
    );

    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await request(app).post('/api/appointments').send({
      jobId: 'job-canary',
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'UTC',
    });
    expect(res.status).toBe(201);

    const events = auditRepo.getAll();
    const created = events.find((e) => e.eventType === 'appointment.created');
    expect(created).toBeDefined();
    expect(created!.entityType).toBe('appointment');
    expect(created!.entityId).toBe(res.body.id);
    expect(created!.tenantId).toBe(TENANT_ID);
  });

  it('PUT /api/locations/:id writes location.updated audit event', async () => {
    const app = express();
    app.use(express.json());
    withAuth(app);

    const locationRepo = new InMemoryLocationRepository();
    const auditRepo = new InMemoryAuditRepository();
    const ownership = permissiveTenantOwnership();

    app.use('/api/locations', createLocationRouter(locationRepo, ownership, auditRepo));

    // Seed a location directly (audit on this seed write is ignored).
    const seed = await createLocation(
      {
        tenantId: TENANT_ID,
        customerId: 'cust-canary',
        street1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      locationRepo,
    );
    auditRepo.clear();

    const res = await request(app).put(`/api/locations/${seed.id}`).send({
      accessNotes: 'Ring twice',
    });
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const updated = events.find((e) => e.eventType === 'location.updated');
    expect(updated).toBeDefined();
    expect(updated!.entityType).toBe('location');
    expect(updated!.entityId).toBe(seed.id);
    expect(updated!.tenantId).toBe(TENANT_ID);
  });

  it('POST /api/notes writes note.created audit event', async () => {
    const app = express();
    app.use(express.json());
    withAuth(app);

    const noteRepo = new InMemoryNoteRepository();
    const auditRepo = new InMemoryAuditRepository();
    const ownership = permissiveTenantOwnership();

    app.use('/api/notes', createNoteRouter(noteRepo, ownership, auditRepo));

    const res = await request(app).post('/api/notes').send({
      entityType: 'customer',
      entityId: 'cust-canary',
      content: 'VIP — handle with care',
    });
    expect(res.status).toBe(201);

    const events = auditRepo.getAll();
    const created = events.find((e) => e.eventType === 'note.created');
    expect(created).toBeDefined();
    expect(created!.entityType).toBe('note');
    expect(created!.entityId).toBe(res.body.id);
    expect(created!.tenantId).toBe(TENANT_ID);
  });

  it('POST /api/conversations writes conversation.created audit event', async () => {
    const app = express();
    app.use(express.json());
    withAuth(app);

    const conversationRepo = new InMemoryConversationRepository();
    const auditRepo = new InMemoryAuditRepository();

    app.use('/api/conversations', createConversationRouter(conversationRepo, auditRepo));

    const res = await request(app).post('/api/conversations').send({
      title: 'Canary conversation',
      entityType: 'job',
      entityId: 'job-canary',
    });
    expect(res.status).toBe(201);

    const events = auditRepo.getAll();
    const created = events.find((e) => e.eventType === 'conversation.created');
    expect(created).toBeDefined();
    expect(created!.entityType).toBe('conversation');
    expect(created!.entityId).toBe(res.body.id);
    expect(created!.tenantId).toBe(TENANT_ID);
  });
});
