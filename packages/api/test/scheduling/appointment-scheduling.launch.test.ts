/**
 * Feature 3 — Appointment scheduling (launch-readiness pass).
 *
 * Given a per-tenant calendar state and a caller's preferred window, asserts
 * the booking layer proposes >= 2 conflict-free slots on the correct
 * technician's calendar: a tech who is busy 10:00-11:00 is never offered that
 * window (buffer-aware), while a free tech is — proving per-tech isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  Appointment,
  AppointmentRepository,
} from '../../src/appointments/appointment';
import {
  AppointmentAssignment,
  AssignmentRepository,
} from '../../src/appointments/assignment';
import { findBookableSlots } from '../../src/scheduling/booking-availability';

const TENANT = 'tenant-sched';
const DAY = '2026-06-15'; // a future weekday relative to the seeded clock
const NOW = new Date('2026-06-10T00:00:00Z');

function appt(over: Partial<Appointment>): Appointment {
  return {
    id: 'a-1', tenantId: TENANT, jobId: 'j-1',
    scheduledStart: new Date(`${DAY}T10:00:00Z`),
    scheduledEnd: new Date(`${DAY}T11:00:00Z`),
    timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
    createdBy: 'u-1', createdAt: NOW, updatedAt: NOW,
    ...over,
  };
}

function makeDeps(appts: Appointment[], assignments: AppointmentAssignment[]) {
  const appointmentRepo = {
    findByDateRange: async (tenantId: string, start: Date, end: Date) =>
      appts.filter(
        (a) => a.tenantId === tenantId && a.scheduledStart < end && a.scheduledEnd > start,
      ),
  } as unknown as AppointmentRepository;

  const assignmentRepo = {
    findByAppointment: async (tenantId: string, appointmentId: string) =>
      assignments.filter((x) => x.appointmentId === appointmentId),
  } as unknown as AssignmentRepository;

  return { appointmentRepo, assignmentRepo };
}

function overlaps(slotStart: Date, slotEnd: Date, busyStart: Date, busyEnd: Date): boolean {
  return slotStart < busyEnd && slotEnd > busyStart;
}

describe('Feature 3 — Appointment scheduling', () => {
  // Tech A is booked 10:00-11:00; Tech B is free all day.
  const techABusy = appt({ id: 'appt-A', jobId: 'job-A' });
  const assignments: AppointmentAssignment[] = [
    { appointmentId: 'appt-A', technicianId: 'tech-A', isPrimary: true },
  ];
  const deps = makeDeps([techABusy], assignments);

  const baseInput = {
    tenantId: TENANT,
    fromDate: DAY,
    toDate: DAY,
    timezone: 'UTC',
    durationMin: 60,
    maxSlots: 18,
    now: NOW,
  };

  it('proposes >= 2 conflict-free slots on the busy tech, none overlapping the booked window', async () => {
    const slots = await findBookableSlots(deps, { ...baseInput, technicianId: 'tech-A' });

    expect(slots.length).toBeGreaterThanOrEqual(2);
    for (const s of slots) {
      // Never overlaps the actual 10:00-11:00 booking...
      expect(overlaps(s.start, s.end, techABusy.scheduledStart, techABusy.scheduledEnd)).toBe(false);
      // ...nor the 30-minute travel buffer around it.
      expect(
        overlaps(
          s.start, s.end,
          new Date(`${DAY}T09:30:00Z`), new Date(`${DAY}T11:30:00Z`),
        ),
      ).toBe(false);
    }
    // The busy tech is specifically NOT offered the 10:00 start.
    expect(slots.some((s) => s.start.toISOString() === `${DAY}T10:00:00.000Z`)).toBe(false);
  });

  it('offers the 10:00 window to a different, free technician (per-tech isolation)', async () => {
    const slots = await findBookableSlots(deps, { ...baseInput, technicianId: 'tech-B' });

    expect(slots.length).toBeGreaterThanOrEqual(2);
    // Tech B has no appointments, so the window Tech A is busy in is open.
    expect(slots.some((s) => s.start.toISOString() === `${DAY}T10:00:00.000Z`)).toBe(true);
  });

  it('keeps every proposed slot inside the business-hours window', async () => {
    const slots = await findBookableSlots(deps, { ...baseInput, technicianId: 'tech-B' });
    const open = new Date(`${DAY}T08:00:00Z`).getTime();
    const close = new Date(`${DAY}T17:00:00Z`).getTime();
    for (const s of slots) {
      expect(s.start.getTime()).toBeGreaterThanOrEqual(open);
      expect(s.end.getTime()).toBeLessThanOrEqual(close);
    }
  });
});
