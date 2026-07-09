/**
 * U3 — POST /api/appointments/:id/running-late
 *
 * Technicians deliberately hold only `appointments:view` (auth/rbac.ts), so
 * the PUT /:id virtual-status branch (gated `appointments:update`) always
 * 403'd their running-late notices. These tests pin the technician-reachable
 * endpoint plus PUT backcompat for dispatcher clients — both delegate to the
 * same helper, which is a notification trigger only (no mutation, no audit).
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

const TENANT_ID = 'tenant-running-late';

function buildRunningLateApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = (req.header('x-test-role') as 'owner' | 'dispatcher' | 'technician') ?? 'technician';
    (req as AuthenticatedRequest).auth = {
      userId: req.header('x-test-user-id') ?? 'tech-1',
      sessionId: 'session-running-late-test',
      tenantId: TENANT_ID,
      role,
    };
    next();
  });

  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const timelineRepo = new InMemoryJobTimelineRepository();
  const enqueueDelayNotice = vi.fn().mockResolvedValue('delay-key-1');
  const coordinator: DelayNotificationEnqueuer = { enqueueDelayNotice };
  app.use(
    '/api/appointments',
    createAppointmentRouter(appointmentRepo, permissiveTenantOwnership(), jobRepo, timelineRepo, {
      delayNotificationCoordinator: coordinator,
    }),
  );
  return { app, jobRepo, timelineRepo, enqueueDelayNotice };
}

/**
 * Seed the job an appointment hangs off, assigned to `assignedTechnicianId`.
 * The running-late endpoint verifies technician ownership against this job.
 */
async function seedAppointment(
  app: Express,
  jobRepo: InMemoryJobRepository,
  assignedTechnicianId: string = 'tech-1',
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
  it('lets a technician send a running-late notice, defaulting to 20 minutes', async () => {
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

  it('passes explicit delayMinutes and derives delayVersion from running-behind history', async () => {
    const { app, jobRepo, timelineRepo, enqueueDelayNotice } = buildRunningLateApp();
    const { appointmentId, jobId } = await seedAppointment(app, jobRepo);

    await addDelayAcknowledgmentTimelineEntry(TENANT_ID, jobId, 'tech-1', 'technician', timelineRepo, {
      appointmentId,
      isRunningBehind: true,
      delayMinutes: 15,
      actorId: 'tech-1',
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
    const { app, jobRepo, enqueueDelayNotice } = buildRunningLateApp();
    // Job assigned to tech-1; the request comes from tech-2.
    const { appointmentId } = await seedAppointment(app, jobRepo, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/running-late`)
      .set('x-test-role', 'technician')
      .set('x-test-user-id', 'tech-2')
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
