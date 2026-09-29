/**
 * #1402 §3/§15 — scheduling integrity at the appointment routes.
 *
 * Owner-approved rule: an appointment whose START is in the past is
 * BLOCKED (typed 400 VALIDATION_ERROR) on create and on reschedule; an
 * appointment outside the tenant's configured business hours is allowed
 * but carries a WARNING. No business hours configured → no warning.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { buildTestApp, TEST_TENANT_ID } from './test-app';

const HOUR = 60 * 60 * 1000;

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

describe('#1402 — appointments cannot start in the past', () => {
  let app: Express;
  let built: Awaited<ReturnType<typeof buildTestApp>> & { tenantId: string };

  beforeEach(async () => {
    const b = await buildTestApp();
    built = { ...b, tenantId: TEST_TENANT_ID };
    app = b.app;
  });

  it('POST with a start yesterday returns 400 VALIDATION_ERROR naming the past start', async () => {
    const res = await request(app).post('/api/appointments').send({
      jobId: 'job-1',
      scheduledStart: iso(-24 * HOUR),
      scheduledEnd: iso(-22 * HOUR),
      timezone: 'UTC',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/in the past/i);
  });

  it('PUT moving the start to yesterday returns 400 VALIDATION_ERROR', async () => {
    const created = await request(app).post('/api/appointments').send({
      jobId: 'job-1',
      scheduledStart: iso(24 * HOUR),
      scheduledEnd: iso(26 * HOUR),
      timezone: 'UTC',
    });
    expect(created.status).toBe(201);

    const res = await request(app)
      .put(`/api/appointments/${created.body.id}`)
      .send({ scheduledStart: iso(-24 * HOUR), scheduledEnd: iso(-22 * HOUR) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/in the past/i);
  });

  it('PUT that re-sends an unchanged past start (e.g. a notes edit) still succeeds', async () => {
    const { appointmentRepo } = built;
    const pastStart = new Date(Date.now() - 24 * HOUR);
    const past = await appointmentRepo.create({
      id: '00000000-0000-4000-8000-000000001402',
      tenantId: built.tenantId,
      jobId: 'job-1',
      scheduledStart: pastStart,
      scheduledEnd: new Date(Date.now() - 22 * HOUR),
      timezone: 'UTC',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: 'seed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .put(`/api/appointments/${past.id}`)
      .send({ scheduledStart: pastStart.toISOString(), notes: 'Tech left a note' });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('Tech left a note');
  });
});

/** A UTC instant `days` from today at `hh:00`. */
function futureAt(days: number, hh: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, 0, 0, 0);
  return d.toISOString();
}

const EVERY_DAY_8_TO_5 = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
  sat: { open: '08:00', close: '17:00' },
  sun: { open: '08:00', close: '17:00' },
};

describe('#1402 — outside business hours is a warning, not a block', () => {
  let app: Express;
  let settingsRepo: Awaited<ReturnType<typeof buildTestApp>>['settingsRepo'];

  beforeEach(async () => {
    ({ app, settingsRepo } = await buildTestApp());
  });

  it('POST at 22:00 when the tenant closes at 17:00 succeeds with an outside-business-hours warning', async () => {
    await settingsRepo.update(TEST_TENANT_ID, { timezone: 'UTC', businessHours: EVERY_DAY_8_TO_5 });

    const res = await request(app).post('/api/appointments').send({
      jobId: 'job-1',
      scheduledStart: futureAt(7, 22),
      scheduledEnd: futureAt(7, 23),
      timezone: 'UTC',
    });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(['Appointment is outside business hours']);
  });

  it('PUT rescheduling to 22:00 succeeds with the same warning', async () => {
    await settingsRepo.update(TEST_TENANT_ID, { timezone: 'UTC', businessHours: EVERY_DAY_8_TO_5 });
    const created = await request(app).post('/api/appointments').send({
      jobId: 'job-1',
      scheduledStart: futureAt(7, 9),
      scheduledEnd: futureAt(7, 10),
      timezone: 'UTC',
    });
    expect(created.status).toBe(201);
    expect(created.body.warnings).toBeUndefined();

    const res = await request(app)
      .put(`/api/appointments/${created.body.id}`)
      .send({ scheduledStart: futureAt(7, 22), scheduledEnd: futureAt(7, 23) });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(['Appointment is outside business hours']);
  });

  it('no business hours configured → no warning at 22:00', async () => {
    const res = await request(app).post('/api/appointments').send({
      jobId: 'job-1',
      scheduledStart: futureAt(7, 22),
      scheduledEnd: futureAt(7, 23),
      timezone: 'UTC',
    });

    expect(res.status).toBe(201);
    expect(res.body.warnings).toBeUndefined();
  });
});
