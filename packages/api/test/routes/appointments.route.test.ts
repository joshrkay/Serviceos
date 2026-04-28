/**
 * Layer 1 — Route Shape Tests: Appointments (Scheduling)
 *
 * Proves that appointment endpoints create/read scheduled rows and return
 * the scheduling fields the UI expects.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildTestApp } from './test-app';
import type { Express } from 'express';
import express, { Request, Response, NextFunction } from 'express';
import { createAppointmentRouter } from '../../src/routes/appointments';
import { createJobRouter } from '../../src/routes/jobs';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { InMemoryQueue } from '../../src/queues/queue';
import { NoopFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { DelayNotificationEnqueuer } from '../../src/routes/appointments';

function tomorrowIso(hoursFromNowStart: number, hoursFromNowEnd: number) {
  const start = new Date(Date.now() + hoursFromNowStart * 60 * 60 * 1000);
  const end = new Date(Date.now() + hoursFromNowEnd * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

describe('POST /api/appointments', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 201 with a created appointment row shape', async () => {
    const { start, end } = tomorrowIso(24, 26);

    const res = await request(app).post('/api/appointments').send({
      jobId: 'job-1',
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'UTC',
      notes: 'Morning window',
    });

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.jobId).toBe('job-1');
    expect(res.body.status).toBe('scheduled');
    expect(res.body.timezone).toBe('UTC');
  });

  it('persists created appointments and returns them via GET /api/appointments?jobId=', async () => {
    const { start, end } = tomorrowIso(24, 26);

    const created = await request(app).post('/api/appointments').send({
      jobId: 'job-abc',
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'UTC',
    });
    expect(created.status).toBe(201);

    const listed = await request(app).get('/api/appointments').query({ jobId: 'job-abc' });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body)).toBe(true);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(created.body.id);
  });
});

describe('POST /api/appointments/:id/delay-ack', () => {
  function buildDelayAckApp(options?: { delayNotificationCoordinator?: DelayNotificationEnqueuer }): Express {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = (req.header('x-test-role') as 'owner' | 'dispatcher' | 'technician') ?? 'dispatcher';
      const userId = req.header('x-test-user-id') ?? 'dispatcher-1';
      (req as AuthenticatedRequest).auth = {
        userId,
        sessionId: 'session-delay-ack-test',
        tenantId: 'tenant-delay-ack',
        role,
      };
      next();
    });

    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const timelineRepo = new InMemoryJobTimelineRepository();
    const auditRepo = new InMemoryAuditRepository();
    const ownership = permissiveTenantOwnership();
    app.use('/api/jobs', createJobRouter(jobRepo, timelineRepo, auditRepo, ownership, new InMemoryQueue(), new NoopFeedbackDispatcher()));
    app.use('/api/appointments', createAppointmentRouter(appointmentRepo, ownership, jobRepo, timelineRepo, options));
    return app;
  }

  async function seedScheduledAppointment(app: Express, assignedTechnicianId: string): Promise<string> {
    const jobRes = await request(app).post('/api/jobs').set('x-test-role', 'dispatcher').send({
      customerId: 'c-delay',
      locationId: 'l-delay',
      summary: 'Delay ack job',
    });
    expect(jobRes.status).toBe(201);

    const assigned = await request(app)
      .put(`/api/jobs/${jobRes.body.id}`)
      .set('x-test-role', 'dispatcher')
      .send({ assignedTechnicianId });
    expect(assigned.status).toBe(200);

    const start = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const apptRes = await request(app).post('/api/appointments').set('x-test-role', 'dispatcher').send({
      jobId: jobRes.body.id,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'UTC',
    });
    expect(apptRes.status).toBe(201);
    return apptRes.body.id;
  }

  it('allows dispatcher to submit delay acknowledgement', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'dispatcher')
      .set('x-test-user-id', 'dispatcher-1')
      .send({
      appointmentId,
      isRunningBehind: true,
      delayMinutes: 15,
      reasonCode: 'traffic',
    });

    expect(res.status).toBe(201);
    expect(res.body.inferredTriggerState).toBe('running_behind');
    expect(res.body.timelineEntry.eventType).toBe('delay_acknowledged');
    expect(res.body.timelineEntry.metadata.delayMinutes).toBe(15);
  });

  it('allows assigned technician to submit delay acknowledgement', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'technician')
      .set('x-test-user-id', 'tech-1')
      .send({
      appointmentId,
      isRunningBehind: false,
    });

    expect(res.status).toBe(201);
    expect(res.body.inferredTriggerState).toBe('on_time');
  });

  it('rejects non-assigned technician', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'technician')
      .set('x-test-user-id', 'tech-not-assigned')
      .send({
      appointmentId,
      isRunningBehind: true,
      delayMinutes: 10,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('rejects owner role for delay acknowledgement endpoint', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'owner')
      .set('x-test-user-id', 'owner-1')
      .send({
      appointmentId,
      isRunningBehind: true,
      delayMinutes: 60,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('rejects running-behind acknowledgement without fixed delay value', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'dispatcher')
      .set('x-test-user-id', 'dispatcher-1')
      .send({
        appointmentId,
        isRunningBehind: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects delayMinutes when not running behind', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'dispatcher')
      .set('x-test-user-id', 'dispatcher-1')
      .send({
        appointmentId,
        isRunningBehind: false,
        delayMinutes: 15,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects body appointmentId mismatch with route id', async () => {
    const app = buildDelayAckApp();
    const appointmentId = await seedScheduledAppointment(app, 'tech-1');

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/delay-ack`)
      .set('x-test-role', 'dispatcher')
      .set('x-test-user-id', 'dispatcher-1')
      .send({
        appointmentId: 'different-id',
        isRunningBehind: true,
        delayMinutes: 10,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
