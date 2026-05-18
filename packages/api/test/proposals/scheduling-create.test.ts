import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

describe('POST /api/proposals — scheduling create with version + feasibility gates', () => {
  let app: express.Express;
  let proposalRepo: InMemoryProposalRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let appointment: any;
  let feasibilityDeps: FeasibilityDependencies;
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    appointment = await createAppointment({
      tenantId, jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);

    feasibilityDeps = {
      assignmentRepo: { findByTechnician: async () => [] } as any,
      appointmentRepo,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
    const userRepo = { findById: async () => ({ id: 'tech-1', role: 'technician' }) } as any;

    app = express();
    app.use(express.json());
    app.use((req: any, _r, n) => { req.auth = { tenantId, userId: 'user-1', role: 'dispatcher' }; n(); });
    app.use('/api/proposals', createProposalsRouter(proposalRepo, appointmentRepo, undefined, feasibilityDeps));
  });

  function send(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return request(app).post('/api/proposals').set(headers).send({
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: appointment.id,
        newScheduledStart: '2026-05-17T12:00:00Z',
        newScheduledEnd: '2026-05-17T13:00:00Z',
      },
      summary: 'reschedule via test',
      ...over,
    });
  }

  it('creates a proposal when If-Match matches updatedAt', async () => {
    const res = await send({}, { 'If-Match': appointment.updatedAt.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  it('returns 409 STALE_APPOINTMENT when If-Match does not match', async () => {
    const res = await send({}, { 'If-Match': '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_APPOINTMENT');
    expect(res.body.currentVersion).toBe(appointment.updatedAt.toISOString());
    expect(res.body.providedVersion).toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns 400 MISSING_VERSION when neither header nor body version is present', async () => {
    const res = await send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_VERSION');
  });

  it('returns 400 INVALID_VERSION when If-Match is not a valid ISO date', async () => {
    const res = await send({}, { 'If-Match': 'not-an-iso-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_VERSION');
  });

  it('prefers If-Match over body.appointmentVersion when both are present and differ', async () => {
    const res = await send(
      { appointmentVersion: '2020-01-01T00:00:00.000Z' },
      { 'If-Match': appointment.updatedAt.toISOString() },
    );
    expect(res.status).toBe(200);
  });

  it('returns 404 before the version check when the appointment does not exist', async () => {
    const res = await request(app).post('/api/proposals')
      .set('If-Match', '2026-01-01T00:00:00.000Z')
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId: 'missing', newScheduledStart: '2026-05-17T12:00:00Z', newScheduledEnd: '2026-05-17T13:00:00Z' },
        summary: 'x',
      });
    expect(res.status).toBe(404);
  });

  it('returns 422 INFEASIBLE with the full FeasibilityResult when overlap blocks', async () => {
    // Inject a conflicting sibling
    const conflict = await createAppointment({
      tenantId, jobId: 'job-2',
      scheduledStart: new Date('2026-05-17T12:30:00Z'),
      scheduledEnd: new Date('2026-05-17T13:30:00Z'),
      timezone: 'UTC', createdBy: 'user-1',
    }, appointmentRepo);
    feasibilityDeps.assignmentRepo = {
      findByTechnician: async () => [
        { id: 'as1', tenantId, appointmentId: appointment.id, technicianId: 'tech-1', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date() },
        { id: 'as2', tenantId, appointmentId: conflict.id, technicianId: 'tech-1', isPrimary: true, assignedBy: 'user-1', assignedAt: new Date() },
      ],
    } as any;
    const res = await send(
      { payload: { appointmentId: appointment.id, toTechnicianId: 'tech-1', newScheduledStart: '2026-05-17T12:00:00Z', newScheduledEnd: '2026-05-17T13:00:00Z' } },
      { 'If-Match': appointment.updatedAt.toISOString() },
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INFEASIBLE');
    expect(res.body.blocking.length).toBeGreaterThan(0);
    expect(res.body.feasible).toBe(false);
  });

  it('returns 400 for proposal types other than reschedule/reassign', async () => {
    const res = await send({ proposalType: 'create_customer', payload: {} }, { 'If-Match': appointment.updatedAt.toISOString() });
    expect(res.status).toBe(400);
  });
});
