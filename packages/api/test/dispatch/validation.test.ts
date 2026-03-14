import { describe, it, expect } from 'vitest';
import { detectOverlappingAppointments, detectAvailabilityConflicts } from '../../src/dispatch/validation';
import { TechnicianWorkingHours } from '../../src/availability/working-hours';
import { UnavailableBlock } from '../../src/availability/unavailable-block';

describe('P6-016 — Overlapping-appointment conflict detection', () => {
  const techId = 'tech-1';

  it('detects overlapping appointments for same technician', () => {
    const conflicts = detectOverlappingAppointments(
      techId,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T11:00:00Z'),
      [{
        id: 'appt-1', technicianId: techId,
        scheduledStart: new Date('2026-03-14T10:00:00Z'),
        scheduledEnd: new Date('2026-03-14T12:00:00Z'),
        status: 'scheduled',
      }],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('overlapping_appointment');
    expect(conflicts[0].severity).toBe('blocking');
    expect(conflicts[0].conflictingEntityId).toBe('appt-1');
  });

  it('does not detect non-overlapping appointments', () => {
    const conflicts = detectOverlappingAppointments(
      techId,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T10:00:00Z'),
      [{
        id: 'appt-1', technicianId: techId,
        scheduledStart: new Date('2026-03-14T10:00:00Z'),
        scheduledEnd: new Date('2026-03-14T12:00:00Z'),
        status: 'scheduled',
      }],
    );

    expect(conflicts).toHaveLength(0);
  });

  it('ignores appointments for different technicians', () => {
    const conflicts = detectOverlappingAppointments(
      techId,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T11:00:00Z'),
      [{
        id: 'appt-1', technicianId: 'tech-2',
        scheduledStart: new Date('2026-03-14T09:00:00Z'),
        scheduledEnd: new Date('2026-03-14T11:00:00Z'),
        status: 'scheduled',
      }],
    );

    expect(conflicts).toHaveLength(0);
  });

  it('ignores canceled and completed appointments', () => {
    const conflicts = detectOverlappingAppointments(
      techId,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T11:00:00Z'),
      [
        {
          id: 'appt-1', technicianId: techId,
          scheduledStart: new Date('2026-03-14T09:00:00Z'),
          scheduledEnd: new Date('2026-03-14T11:00:00Z'),
          status: 'canceled',
        },
        {
          id: 'appt-2', technicianId: techId,
          scheduledStart: new Date('2026-03-14T09:00:00Z'),
          scheduledEnd: new Date('2026-03-14T11:00:00Z'),
          status: 'completed',
        },
      ],
    );

    expect(conflicts).toHaveLength(0);
  });

  it('excludes specified appointment', () => {
    const conflicts = detectOverlappingAppointments(
      techId,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T11:00:00Z'),
      [{
        id: 'appt-1', technicianId: techId,
        scheduledStart: new Date('2026-03-14T09:00:00Z'),
        scheduledEnd: new Date('2026-03-14T11:00:00Z'),
        status: 'scheduled',
      }],
      'appt-1',
    );

    expect(conflicts).toHaveLength(0);
  });

  it('detects multiple overlapping appointments', () => {
    const conflicts = detectOverlappingAppointments(
      techId,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T17:00:00Z'),
      [
        {
          id: 'appt-1', technicianId: techId,
          scheduledStart: new Date('2026-03-14T08:00:00Z'),
          scheduledEnd: new Date('2026-03-14T10:00:00Z'),
          status: 'confirmed',
        },
        {
          id: 'appt-2', technicianId: techId,
          scheduledStart: new Date('2026-03-14T14:00:00Z'),
          scheduledEnd: new Date('2026-03-14T16:00:00Z'),
          status: 'in_progress',
        },
      ],
    );

    expect(conflicts).toHaveLength(2);
  });
});

describe('P6-017 — Availability-block conflict detection', () => {
  const workingHours: TechnicianWorkingHours = {
    id: 'wh-1',
    tenantId: 'tenant-1',
    technicianId: 'tech-1',
    dayOfWeek: 6, // Saturday
    startTime: '08:00',
    endTime: '17:00',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('detects appointment outside working hours', () => {
    const conflicts = detectAvailabilityConflicts(
      new Date('2026-03-14T06:00:00'),
      new Date('2026-03-14T08:00:00'),
      workingHours,
      [],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('outside_working_hours');
    expect(conflicts[0].severity).toBe('warning');
  });

  it('no conflict when within working hours', () => {
    const conflicts = detectAvailabilityConflicts(
      new Date('2026-03-14T09:00:00'),
      new Date('2026-03-14T11:00:00'),
      workingHours,
      [],
    );

    expect(conflicts).toHaveLength(0);
  });

  it('detects conflict with unavailable block', () => {
    const block: UnavailableBlock = {
      id: 'block-1',
      tenantId: 'tenant-1',
      technicianId: 'tech-1',
      startTime: new Date('2026-03-14T12:00:00Z'),
      endTime: new Date('2026-03-14T13:00:00Z'),
      reason: 'Lunch break',
      createdBy: 'user-1',
      createdAt: new Date(),
    };

    const conflicts = detectAvailabilityConflicts(
      new Date('2026-03-14T11:30:00Z'),
      new Date('2026-03-14T12:30:00Z'),
      null,
      [block],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('unavailable_block');
    expect(conflicts[0].severity).toBe('warning');
    expect(conflicts[0].message).toContain('Lunch break');
  });

  it('no conflict when not overlapping unavailable block', () => {
    const block: UnavailableBlock = {
      id: 'block-1',
      tenantId: 'tenant-1',
      technicianId: 'tech-1',
      startTime: new Date('2026-03-14T12:00:00Z'),
      endTime: new Date('2026-03-14T13:00:00Z'),
      createdBy: 'user-1',
      createdAt: new Date(),
    };

    const conflicts = detectAvailabilityConflicts(
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T11:00:00Z'),
      null,
      [block],
    );

    expect(conflicts).toHaveLength(0);
  });

  it('handles null working hours gracefully', () => {
    const conflicts = detectAvailabilityConflicts(
      new Date('2026-03-14T06:00:00'),
      new Date('2026-03-14T08:00:00'),
      null,
      [],
    );

    expect(conflicts).toHaveLength(0);
  });
});
