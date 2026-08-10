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
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
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

describe('P1-018 — listAppointments date range + pagination', () => {
  let app: Express;
  let assignmentRepo: Awaited<ReturnType<typeof buildTestApp>>['assignmentRepo'];

  beforeEach(async () => {
    ({ app, assignmentRepo } = await buildTestApp());
  });

  /**
   * PR #815 review, Important 3 — this harness previously constructed
   * appointmentRepo bare (no assignment lookup wired in), so this exact
   * request 500'd once InMemoryAppointmentRepository started throwing on an
   * unconfigured technicianId filter rather than silently ignoring it.
   * Fixed by threading test-app.ts's own assignmentRepo into
   * appointmentRepo — this pins that the shared harness now supports the
   * query end-to-end (route → listAppointmentsWithMeta →
   * InMemoryAppointmentRepository.listWithMeta → InMemoryAssignmentRepository),
   * not just that it no longer throws.
   */
  it('GET /api/appointments?technicianId= filters to only that technician\'s appointments', async () => {
    const { start: start1, end: end1 } = tomorrowIso(1, 3);
    const assigned = await request(app).post('/api/appointments').send({
      jobId: 'job-tech-1',
      scheduledStart: start1,
      scheduledEnd: end1,
      timezone: 'UTC',
    });
    expect(assigned.status).toBe(201);

    const { start: start2, end: end2 } = tomorrowIso(4, 6);
    const unassigned = await request(app).post('/api/appointments').send({
      jobId: 'job-tech-2',
      scheduledStart: start2,
      scheduledEnd: end2,
      timezone: 'UTC',
    });
    expect(unassigned.status).toBe(201);

    await assignmentRepo.create({
      id: 'asg-route-test-1',
      tenantId: 'tenant-test-1',
      appointmentId: assigned.body.id,
      technicianId: 'tech-route-1',
      isPrimary: true,
      assignedBy: 'dispatcher-1',
      assignedAt: new Date(),
    });

    const res = await request(app).get('/api/appointments').query({ technicianId: 'tech-route-1' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(assigned.body.id);
  });

  async function seedAt(jobId: string, hoursOffset: number) {
    const start = new Date(Date.now() + hoursOffset * 60 * 60 * 1000);
    const end = new Date(Date.now() + (hoursOffset + 2) * 60 * 60 * 1000);
    return request(app).post('/api/appointments').send({
      jobId,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      timezone: 'UTC',
    });
  }

  it('filter by date range returns only appointments in window', async () => {
    await seedAt('job-1', 1); // tomorrow + 1h
    await seedAt('job-2', 24 * 7); // a week out
    const fromDate = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30m from now
    const toDate = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6h from now

    const res = await request(app).get(
      `/api/appointments?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].jobId).toBe('job-1');
  });

  it('pagination with limit/offset returns { data, total }', async () => {
    await seedAt('job-1', 1);
    await seedAt('job-2', 2);
    await seedAt('job-3', 3);
    const res = await request(app).get('/api/appointments?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });

  it('rejects limit > 200 with 400', async () => {
    const res = await request(app).get('/api/appointments?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid fromDate with 400', async () => {
    const res = await request(app).get('/api/appointments?fromDate=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('legacy ?jobId= still returns bare array of appointments', async () => {
    await seedAt('job-x', 1);
    await seedAt('job-x', 4);
    await seedAt('job-y', 1);
    const res = await request(app).get('/api/appointments?jobId=job-x');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  /**
   * Follow-up to PR #815 — an EMPTY-valued query param means "no filter",
   * never "match the row whose column equals the empty string".
   *
   * Both repositories already agree on that for the value itself
   * (`if (options?.technicianId)` — a truthiness test — in
   * PgAppointmentRepository.buildListWhere, InMemoryAppointmentRepository
   * .listWithMeta, and listAppointmentsWithMeta's no-listWithMeta fallback,
   * so `''` adds no predicate and does not trip the fallback's "cannot filter
   * by technician" throw either). The ROUTE disagreed: it only checked
   * `typeof req.query.technicianId === 'string'`, so a present-but-empty param
   * became `''` — still `!== undefined` — and flipped `wantsPaginated` on.
   * The observable damage is the response ENVELOPE, not the rows:
   * `?jobId=x&technicianId=` silently switched the legacy bare-array contract
   * to `{ data, total }`, and a bare `?technicianId=` turned the historical
   * "jobId query parameter is required" 400 into a 200 listing every
   * appointment in the tenant.
   */
  describe('empty-valued filter params mean "no filter"', () => {
    it('?technicianId= (present but empty) is treated as absent — same 400 as no filter at all', async () => {
      await seedAt('job-empty-tech', 1);
      const res = await request(app).get('/api/appointments?technicianId=');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('?jobId=…&technicianId= keeps the legacy bare-array contract', async () => {
      await seedAt('job-empty-tech-2', 1);
      await seedAt('job-empty-tech-2', 4);
      await seedAt('job-other', 1);
      const res = await request(app).get('/api/appointments?jobId=job-empty-tech-2&technicianId=');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it('?status= (present but empty) is treated as absent too — same defect, same parse', async () => {
      await seedAt('job-empty-status', 1);
      const res = await request(app).get('/api/appointments?status=');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('a NON-empty technicianId still filters (the fix must not disable the filter)', async () => {
      const assigned = await seedAt('job-real-tech', 1);
      await seedAt('job-real-tech-2', 4);
      await assignmentRepo.create({
        id: 'asg-empty-guard-1',
        tenantId: 'tenant-test-1',
        appointmentId: assigned.body.id,
        technicianId: 'tech-real-1',
        isPrimary: true,
        assignedBy: 'dispatcher-1',
        assignedAt: new Date(),
      });

      const res = await request(app).get('/api/appointments?technicianId=tech-real-1');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe(assigned.body.id);
    });

    /**
     * Follow-up review J6 — `limit` and `offset` were left on the bare
     * `req.query.x !== undefined` check twenty lines below the fix above, and
     * for them the outcome is WORSE than a swapped envelope: `''` flips
     * `wantsPaginated` on, then `parseInt('', 10)` is NaN, so the legacy
     * bare-array contract becomes a hard 400 with a message
     * ("limit must be between 1 and 200") that names a bound the caller never
     * crossed. `fromDate`/`toDate` were fixed by the same commit but never
     * pinned; they are pinned here so the pair cannot drift apart again.
     */
    for (const param of ['limit', 'offset', 'fromDate', 'toDate']) {
      it(`?jobId=…&${param}= (present but empty) keeps the legacy bare-array contract`, async () => {
        const jobId = `job-empty-${param.toLowerCase()}`;
        await seedAt(jobId, 1);
        await seedAt(jobId, 4);
        await seedAt('job-untouched', 1);

        const res = await request(app).get(`/api/appointments?jobId=${jobId}&${param}=`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(2);
      });

      it(`a bare ?${param}= is treated as absent — same 400 as no filter at all`, async () => {
        const res = await request(app).get(`/api/appointments?${param}=`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('VALIDATION_ERROR');
        expect(res.body.message).toBe('jobId query parameter is required');
      });
    }

    it('a NON-empty limit/offset still paginates (the fix must not disable them)', async () => {
      await seedAt('job-paginate-guard', 1);
      await seedAt('job-paginate-guard', 4);
      await seedAt('job-paginate-guard', 7);

      const res = await request(app).get('/api/appointments?limit=2&offset=1');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.total).toBe(3);
    });
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

    // Threaded into appointmentRepo so its listWithMeta technicianId filter
    // works instead of throwing (PR #815 review, Important 3) — see
    // in-memory-appointment.ts's TechnicianAssignmentLookup.
    const assignmentRepo = new InMemoryAssignmentRepository();
    const appointmentRepo = new InMemoryAppointmentRepository(assignmentRepo);
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
