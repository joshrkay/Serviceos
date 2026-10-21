import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchedulingRouter } from '../../src/scheduling/routes';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { noSkillConstraints } from '../helpers/no-skill-constraints';
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
    workingHoursRepo: { findByTechnician: async () => [] } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: noSkillConstraints(),
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

describe('GET /api/dispatch/appointments/:id/suggested-technicians', () => {
  const APPT_ID = '11111111-1111-4111-8111-111111111111';

  function suggestApp(appts: Appointment[], users: any[], primaryTechId?: string, crewTechId?: string) {
    const deps: FeasibilityDependencies = {
      assignmentRepo: {
        findByTechnician: async () => [],
        findByAppointment: async () => [
          ...(primaryTechId ? [{ appointmentId: APPT_ID, technicianId: primaryTechId, isPrimary: true }] : []),
          ...(crewTechId ? [{ appointmentId: APPT_ID, technicianId: crewTechId, isPrimary: false }] : []),
        ],
      } as any,
      appointmentRepo: {
        findById: async (_t: string, id: string) => appts.find((a) => a.id === id) ?? null,
      } as any,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: { findByTechnician: async () => [] } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: noSkillConstraints(),
    };
    const userRepo = {
      findByTenant: async (_t: string, opts?: { role?: string }) =>
        users.filter((u) => !opts?.role || u.role === opts.role),
    } as any;
    const app = express();
    app.use(express.json());
    app.use(fakeAuth);
    app.use('/api/dispatch', createSchedulingRouter(deps, userRepo));
    return app;
  }

  const tech = (id: string, firstName: string) => ({
    id, tenantId: 't-1', email: `${id}@x.test`, role: 'technician', firstName,
    canFieldServe: false, createdAt: new Date(), updatedAt: new Date(),
  });

  it('returns active technicians ranked, marking the current primary', async () => {
    const app = suggestApp(
      [appt({ id: APPT_ID })],
      [tech('tech-b', 'Bo'), tech('tech-a', 'Al'), { ...tech('d-1', 'Di'), role: 'dispatcher' }],
      'tech-b',
    );
    const res = await request(app).get(`/api/dispatch/appointments/${APPT_ID}/suggested-technicians`);
    expect(res.status).toBe(200);
    expect(res.body.appointmentId).toBe(APPT_ID);
    expect(res.body.suggestions.map((s: any) => s.technicianId)).toEqual(['tech-a', 'tech-b']);
    expect(res.body.suggestions[1]).toMatchObject({ name: 'Bo', feasible: true, isCurrent: true });
  });

  it('marks a crew member with no primary as already on the visit, so the board never offers them', async () => {
    const app = suggestApp([appt({ id: APPT_ID })], [tech('tech-a', 'Al'), tech('tech-c', 'Cy')], undefined, 'tech-c');
    const res = await request(app).get(`/api/dispatch/appointments/${APPT_ID}/suggested-technicians`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.suggestions.map((s: any) => [s.technicianId, s.isCurrent]));
    expect(byId).toEqual({ 'tech-a': false, 'tech-c': true });
  });

  it('returns 404 for an unknown appointment', async () => {
    const app = suggestApp([], [tech('tech-a', 'Al')]);
    const res = await request(app).get(`/api/dispatch/appointments/${APPT_ID}/suggested-technicians`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('APPOINTMENT_NOT_FOUND');
  });

  it('returns 404 for a malformed id without touching the repos', async () => {
    const app = suggestApp([], []);
    const res = await request(app).get('/api/dispatch/appointments/not-a-uuid/suggested-technicians');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
