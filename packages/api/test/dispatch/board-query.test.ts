import { describe, it, expect, beforeEach } from 'vitest';
import { getDispatchBoardData, BoardQueryDependencies } from '../../src/dispatch/board-query';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../src/appointments/assignment';

describe('P6-006 — Day-scoped dispatch board query', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let deps: BoardQueryDependencies;

  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techId = '660e8400-e29b-41d4-a716-446655440001';

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    deps = {
      appointmentRepo,
      assignmentRepo,
      getTechnicianName: async (id: string) => id === techId ? 'John Smith' : 'Unknown',
    };
  });

  it('returns empty board for day with no appointments', async () => {
    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    expect(result.date).toBe('2026-03-14');
    expect(result.unassignedAppointments).toHaveLength(0);
    expect(result.technicianLanes).toHaveLength(0);
    expect(result.summary.unassigned).toBe(0);
  });

  it('returns unassigned appointments', async () => {
    const appt = await createAppointment({
      tenantId,
      jobId: 'job-1',
      scheduledStart: new Date(2026, 2, 14, 9, 0),
      scheduledEnd: new Date(2026, 2, 14, 11, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    expect(result.unassignedAppointments).toHaveLength(1);
    expect(result.unassignedAppointments[0].id).toBe(appt.id);
    expect(result.summary.unassigned).toBe(1);
  });

  it('groups assigned appointments into technician lanes', async () => {
    const appt = await createAppointment({
      tenantId,
      jobId: 'job-1',
      scheduledStart: new Date(2026, 2, 14, 9, 0),
      scheduledEnd: new Date(2026, 2, 14, 11, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    await assignTechnician({
      tenantId,
      appointmentId: appt.id,
      technicianId: techId,
      technicianRole: 'technician',
      isPrimary: true,
      assignedBy: 'user-1',
    }, assignmentRepo);

    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    expect(result.unassignedAppointments).toHaveLength(0);
    expect(result.technicianLanes).toHaveLength(1);
    expect(result.technicianLanes[0].technicianId).toBe(techId);
    expect(result.technicianLanes[0].technicianName).toBe('John Smith');
    expect(result.technicianLanes[0].appointments).toHaveLength(1);
  });

  it('computes summary correctly', async () => {
    await createAppointment({
      tenantId,
      jobId: 'job-1',
      scheduledStart: new Date(2026, 2, 14, 9, 0),
      scheduledEnd: new Date(2026, 2, 14, 11, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    expect(result.summary.unassigned).toBe(1);
    expect(result.summary.scheduled).toBe(1);
  });

  it('does not include appointments from other days', async () => {
    await createAppointment({
      tenantId,
      jobId: 'job-1',
      scheduledStart: new Date(2026, 2, 15, 9, 0),
      scheduledEnd: new Date(2026, 2, 15, 11, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    expect(result.unassignedAppointments).toHaveLength(0);
    expect(result.technicianLanes).toHaveLength(0);
  });

  it('enforces tenant isolation', async () => {
    await createAppointment({
      tenantId: 'other-tenant',
      jobId: 'job-1',
      scheduledStart: new Date(2026, 2, 14, 9, 0),
      scheduledEnd: new Date(2026, 2, 14, 11, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    expect(result.unassignedAppointments).toHaveLength(0);
  });

  it('sorts lane appointments by scheduled start', async () => {
    const appt1 = await createAppointment({
      tenantId,
      jobId: 'job-1',
      scheduledStart: new Date(2026, 2, 14, 14, 0),
      scheduledEnd: new Date(2026, 2, 14, 16, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    const appt2 = await createAppointment({
      tenantId,
      jobId: 'job-2',
      scheduledStart: new Date(2026, 2, 14, 9, 0),
      scheduledEnd: new Date(2026, 2, 14, 11, 0),
      timezone: 'America/New_York',
      createdBy: 'user-1',
    }, appointmentRepo);

    await assignTechnician({
      tenantId, appointmentId: appt1.id, technicianId: techId,
      technicianRole: 'technician', isPrimary: true, assignedBy: 'user-1',
    }, assignmentRepo);

    await assignTechnician({
      tenantId, appointmentId: appt2.id, technicianId: techId,
      technicianRole: 'technician', isPrimary: true, assignedBy: 'user-1',
    }, assignmentRepo);

    const result = await getDispatchBoardData(tenantId, '2026-03-14', deps);
    const lane = result.technicianLanes[0];
    expect(lane.appointments[0].id).toBe(appt2.id);
    expect(lane.appointments[1].id).toBe(appt1.id);
  });
});
