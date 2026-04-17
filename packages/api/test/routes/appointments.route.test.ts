/**
 * Layer 1 — Route Shape Tests: Appointments (Scheduling)
 *
 * Proves that appointment endpoints create/read scheduled rows and return
 * the scheduling fields the UI expects.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp } from './test-app';
import type { Express } from 'express';

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
