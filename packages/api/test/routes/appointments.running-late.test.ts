/**
 * U3 — POST /api/appointments/:id/running-late
 *
 * Technicians deliberately hold only `appointments:view` (auth/rbac.ts), so
 * the PUT /:id virtual-status branch (gated `appointments:update`) always
 * 403'd their running-late notices. These tests pin the technician-reachable
 * endpoint plus PUT backcompat for dispatcher clients — both delegate to the
 * same audited notification-trigger helper.
 */
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import type { Express } from 'express';
import express, { Request, Response, NextFunction } from 'express';
import { createAppointmentRouter, DelayNotificationEnqueuer } from '../../src/routes/appointments';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import {
  addDelayAcknowledgmentTimelineEntry,
  InMemoryJobTimelineRepository,
} from '../../src/jobs/job-lifecycle';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT_ID = 'tenant-running-late';
const TECH_A_ID = '550e8400-e29b-41d4-a716-446655440020';
const TECH_B_ID = '550e8400-e29b-41d4-a716-446655440021';
const TECH_A_CLERK_ID = 'user_tech_a_clerk';
const TECH_B_CLERK_ID = 'user_tech_b_clerk';

function buildRunningLateApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = (req.header('x-test-role') as 'owner' | 'dispatcher' | 'technician') ?? 'technician';
    (req as AuthenticatedRequest).auth = {
      userId: req.header('x-test-user-id') ?? TECH_A_CLERK_ID,
      canonicalUserId: req.header('x-test-canonical-user-id') ?? TECH_A_ID,
      sessionId: 'session-running-late-test',
      tenantId: TENANT_ID,
      role,
    };
    next();
  });

  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const timelineRepo = new InMemoryJobTimelineRepository();
  const auditRepo = new InMemoryAuditRepository();
  const enqueueDelayNotice = vi.fn().mockResolvedValue('delay-key-1');
  const coordinator: DelayNotificationEnqueuer = { enqueueDelayNotice };
  app.use(
    '/api/appointments',
    createAppointmentRouter(appointmentRepo, permissiveTenantOwnership(), jobRepo, timelineRepo, {
      delayNotificationCoordinator: coordinator,
    }, auditRepo),
  );
  return { app, jobRepo, timelineRepo, enqueueDelayNotice, auditRepo };
}

/**
 * Seed the job an appointment hangs off, assigned to `assignedTechnicianId`.
 * The running-late endpoint verifies technician ownership against this job.
 */
async function seedAppointment(
  app: Express,
  jobRepo: InMemoryJobRepository,
  assignedTechnicianId: string = TECH_A_ID,
): Promise<{ appointmentId: string; jobId: string }> {
  await jobRepo.create({
    id: 'job-running-late',
    tenantId: TENANT_ID,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Running-late test job',
    status: 'scheduled',
    priority: 'normal',
    assignedTechnicianId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<InMemoryJobRepository['create']>[0]);

  const start = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const res = await request(app).post('/api/appointments').set('x-test-role', 'dispatcher').send({
    jobId: 'job-running-late',
    scheduledStart: start,
    scheduledEnd: end,
    timezone: 'UTC',
  });
  expect(res.status).toBe(201);
  return { appointmentId: res.body.id, jobId: res.body.jobId };
}

describe('POST /api/appointments/:id/running-late', () => {
  it('lets a technician send a running-late notice for their canonical users.id', async () => {
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId } = await seedAppointment(app, jobRepo);

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appointmentId, delayMinutes: 20, queued: true });
    expect(enqueueDelayNotice).toHaveBeenCalledTimes(1);
    expect(enqueueDelayNotice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      currentAppointmentId: appointmentId,
      delayVersion: 0,
      delayMinutes: 20,
    });
  });

  it('audits the running-late trigger using the delay idempotency key', async () => {
    const { app, jobRepo, auditRepo } = buildRunningLateApp();
    const { appointmentId, jobId } = await seedAppointment(app, jobRepo);

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .send({ delayMinutes: 20 });

    expect(res.status).toBe(200);
    const events = auditRepo
      .getAll()
      .filter((event) => event.eventType === 'appointment.running_late_triggered');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT_ID,
      actorId: TECH_A_CLERK_ID,
      actorRole: 'technician',
      entityType: 'appointment',
      entityId: appointmentId,
      correlationId: 'delay-key-1',
      metadata: { jobId, delayMinutes: 20, delayVersion: 0 },
    });
  });

  it('passes explicit delayMinutes and derives delayVersion from running-behind history', async () => {
    const { app, jobRepo, timelineRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId, jobId } = await seedAppointment(app, jobRepo);

    await addDelayAcknowledgmentTimelineEntry(TENANT_ID, jobId, TECH_A_ID, 'technician', timelineRepo, {
      appointmentId,
      isRunningBehind: true,
      delayMinutes: 15,
      actorId: TECH_A_ID,
      actorRole: 'technician',
      timestamp: new Date().toISOString(),
      inferredTriggerState: 'running_behind',
    });

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .send({ delayMinutes: 45 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appointmentId, delayMinutes: 45, queued: true });
    expect(enqueueDelayNotice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      currentAppointmentId: appointmentId,
      delayVersion: 1,
      delayMinutes: 45,
    });
  });

  it('returns 404 for an unknown (or cross-tenant) appointment', async () => {
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();

    const res = await request(app)
      .post('/api/appointments/appt-does-not-exist/running-late')
      .set('x-test-role', 'technician')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(enqueueDelayNotice).not.toHaveBeenCalled();
  });

  it('rejects an invalid delayMinutes with a validation error', async () => {
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId } = await seedAppointment(app, jobRepo);

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .send({ delayMinutes: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(enqueueDelayNotice).not.toHaveBeenCalled();
  });

  it('keeps PUT /:id with status running_late working for dispatchers (backcompat)', async () => {
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId } = await seedAppointment(app, jobRepo);

    const res = await request(app)
      .put(`/api/appointments/${appointmentId}`)
      .set('x-test-role', 'dispatcher')
      .send({ status: 'running_late', delayMinutes: 30 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appointmentId, delayMinutes: 30, queued: true });
    expect(enqueueDelayNotice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      currentAppointmentId: appointmentId,
      delayVersion: 0,
      delayMinutes: 30,
    });
  });

  it('403s a technician who is not the assigned tech (no notices for others’ jobs)', async () => {
    const { app, jobRepo, enqueueDelayNotice, auditRepo } = buildRunningLateApp();
    // Job assigned to tech A's users.id; the request comes from tech B's Clerk subject.
    const { appointmentId } = await seedAppointment(app, jobRepo, TECH_A_ID);

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .set('x-test-user-id', TECH_B_CLERK_ID)
      .set('x-test-canonical-user-id', TECH_B_ID)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(enqueueDelayNotice).not.toHaveBeenCalled();
    expect(
      auditRepo.getAll().filter(
        (event) => event.eventType === 'appointment.running_late_triggered',
      ),
    ).toHaveLength(0);
  });

  it('fails closed when the technician canonical identity is unavailable', async () => {
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId } = await seedAppointment(app, jobRepo, TECH_A_ID);

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .set('x-test-user-id', TECH_A_CLERK_ID)
      .set('x-test-canonical-user-id', '')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(enqueueDelayNotice).not.toHaveBeenCalled();
  });

  it('still 403s a technician on the PUT virtual-status path (permission not widened)', async () => {
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId } = await seedAppointment(app, jobRepo);

    const res = await request(app)
      .put(`/api/appointments/${appointmentId}`)
      .set('x-test-role', 'technician')
      .send({ status: 'running_late' });

    expect(res.status).toBe(403);
    expect(enqueueDelayNotice).not.toHaveBeenCalled();
  });
});
