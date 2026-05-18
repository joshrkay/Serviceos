import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchedulingRouter } from '../../src/scheduling/routes';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

function fakeAuth(req: any, _res: any, next: any) {
  req.auth = { tenantId: 't-1', userId: 'u-1', role: 'dispatcher' };
  next();
}

function makeApp(appts: Appointment[], technicians: { id: string; role: string }[]) {
  const deps: FeasibilityDependencies = {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: {
      findById: async (_t: string, id: string) => appts.find((a) => a.id === id) ?? null,
    } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
  };
  const userRepo = {
    findById: async (_t: string, id: string) => technicians.find((u) => u.id === id) ?? null,
  } as any;
  const app = express();
  app.use(express.json());
  app.use(fakeAuth);
  app.use('/api/dispatch', createSchedulingRouter(deps, userRepo));
  return app;
}

const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 'a-1', tenantId: 't-1', jobId: 'j-1',
  scheduledStart: new Date('2026-05-17T10:00:00Z'),
  scheduledEnd: new Date('2026-05-17T11:00:00Z'),
  timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
  createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

describe('POST /api/dispatch/check-feasibility', () => {
  it('returns 200 with feasible:true on a clean proposal', async () => {
    const app = makeApp([appt()], [{ id: 'tech-1', role: 'technician' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.feasible).toBe(true);
    expect(Array.isArray(res.body.blocking)).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(Array.isArray(res.body.info)).toBe(true);
  });

  it('returns 404 when the appointment does not exist', async () => {
    const app = makeApp([], [{ id: 'tech-1', role: 'technician' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'missing', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('APPOINTMENT_NOT_FOUND');
  });

  it('returns 404 when the technician does not exist', async () => {
    const app = makeApp([appt()], []);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'unknown',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TECHNICIAN_NOT_FOUND');
  });

  it('returns 404 when the user exists but is not a technician', async () => {
    const app = makeApp([appt()], [{ id: 'tech-1', role: 'dispatcher' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TECHNICIAN_NOT_FOUND');
  });

  it('returns 400 when scheduledStart/End are not valid ISO dates', async () => {
    const app = makeApp([appt()], [{ id: 'tech-1', role: 'technician' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: 'not-a-date',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(400);
  });
});
