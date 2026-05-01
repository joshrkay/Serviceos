import { describe, it, expect, vi } from 'vitest';
import { DefaultAvailabilityFinder } from '../../../src/ai/tasks/availability-finder';
import {
  Appointment,
  AppointmentRepository,
  AppointmentStatus,
} from '../../../src/appointments/appointment';
import {
  AppointmentAssignment,
  AssignmentRepository,
} from '../../../src/appointments/assignment';

const tenantId = 'tenant-1';
const technicianId = 'tech-1';

function makeAppt(
  id: string,
  start: string,
  end: string,
  overrides: Partial<Appointment> = {}
): Appointment {
  return {
    id,
    tenantId,
    jobId: `job-${id}`,
    scheduledStart: new Date(start),
    scheduledEnd: new Date(end),
    timezone: 'UTC',
    status: 'scheduled' as AppointmentStatus,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface StubOpts {
  appointments?: Appointment[];
  assignments?: Map<string, AppointmentAssignment[]>;
  appointmentThrows?: Error;
  assignmentThrows?: Error;
}

function buildDeps(opts: StubOpts = {}): {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
} {
  const appointments = opts.appointments ?? [];
  const assignments = opts.assignments ?? new Map();

  const appointmentRepo: AppointmentRepository = {
    create: vi.fn(),
    findById: vi.fn(),
    findByJob: vi.fn(),
    findByDateRange: vi.fn(async (tid: string, from: Date, to: Date) => {
      if (opts.appointmentThrows) throw opts.appointmentThrows;
      return appointments.filter(
        (a) =>
          a.tenantId === tid &&
          a.scheduledStart >= from &&
          a.scheduledStart <= to
      );
    }),
    update: vi.fn(),
  };

  const assignmentRepo: AssignmentRepository = {
    create: vi.fn(),
    update: vi.fn(),
    findByAppointment: vi.fn(async (tid: string, appointmentId: string) => {
      if (opts.assignmentThrows) throw opts.assignmentThrows;
      return (assignments.get(appointmentId) ?? []).filter((a) => a.tenantId === tid);
    }),
    findByTechnician: vi.fn(),
    delete: vi.fn(),
  };

  return { appointmentRepo, assignmentRepo };
}

describe('DefaultAvailabilityFinder', () => {
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  it('empty calendar — returns the requested count starting at searchFrom', async () => {
    const finder = new DefaultAvailabilityFinder(buildDeps());

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
      count: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.length).toBe(3);
    expect(result.slots[0].start.toISOString()).toBe('2026-04-21T09:00:00.000Z');
    expect(result.slots[0].end.toISOString()).toBe('2026-04-21T10:00:00.000Z');
    expect(result.slots[1].start.toISOString()).toBe('2026-04-21T09:30:00.000Z');
    expect(result.slots[2].start.toISOString()).toBe('2026-04-21T10:00:00.000Z');
  });

  it('skips a busy window — picks the first slot after the conflict', async () => {
    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointments: [
          makeAppt('a', '2026-04-21T09:00:00Z', '2026-04-21T10:00:00Z'),
        ],
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots[0].start.toISOString()).toBe('2026-04-21T10:00:00.000Z');
  });

  it('honors exclusive boundary — appointment ending at 11:00 leaves 11:00 open', async () => {
    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointments: [
          makeAppt('a', '2026-04-21T10:00:00Z', '2026-04-21T11:00:00Z'),
        ],
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T11:00:00Z'),
      searchTo: new Date('2026-04-21T13:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots[0].start.toISOString()).toBe('2026-04-21T11:00:00.000Z');
  });

  it('back-to-back appointments — finds gaps between, after, ignores too-narrow windows', async () => {
    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointments: [
          makeAppt('a', '2026-04-21T09:00:00Z', '2026-04-21T10:00:00Z'),
          // 10:00 - 10:30 is open but only 30 min — should be skipped for a 60 min req.
          makeAppt('b', '2026-04-21T10:30:00Z', '2026-04-21T12:00:00Z'),
          // 12:00 - 13:00 open (60 min — fits).
          makeAppt('c', '2026-04-21T13:00:00Z', '2026-04-21T14:00:00Z'),
          // 14:00 - 17:00 open.
        ],
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
      count: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const starts = result.slots.map((s) => s.start.toISOString());
    expect(starts).toEqual([
      '2026-04-21T12:00:00.000Z',
      '2026-04-21T14:00:00.000Z',
      '2026-04-21T14:30:00.000Z',
    ]);
  });

  it('skips canceled / completed / no-show appointments', async () => {
    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointments: [
          makeAppt('a', '2026-04-21T09:00:00Z', '2026-04-21T10:00:00Z', { status: 'canceled' }),
          makeAppt('b', '2026-04-21T10:00:00Z', '2026-04-21T11:00:00Z', { status: 'completed' }),
          makeAppt('c', '2026-04-21T11:00:00Z', '2026-04-21T12:00:00Z', { status: 'no_show' }),
        ],
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots[0].start.toISOString()).toBe('2026-04-21T09:00:00.000Z');
  });

  it('filters by technician — only the named tech\'s appointments block', async () => {
    const assignments = new Map<string, AppointmentAssignment[]>();
    assignments.set('a', [
      {
        id: 'asg-a',
        tenantId,
        appointmentId: 'a',
        technicianId,
        isPrimary: true,
        assignedBy: 'user-1',
        assignedAt: new Date(),
      },
    ]);
    // Appointment b is for some other tech — shouldn't block tech-1.
    assignments.set('b', [
      {
        id: 'asg-b',
        tenantId,
        appointmentId: 'b',
        technicianId: 'tech-2',
        isPrimary: true,
        assignedBy: 'user-1',
        assignedAt: new Date(),
      },
    ]);

    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointments: [
          makeAppt('a', '2026-04-21T09:00:00Z', '2026-04-21T10:00:00Z'),
          makeAppt('b', '2026-04-21T10:00:00Z', '2026-04-21T11:00:00Z'),
        ],
        assignments,
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
      technicianId,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // tech-1 only blocked 09:00 - 10:00; 10:00 should be open for tech-1.
    expect(result.slots[0].start.toISOString()).toBe('2026-04-21T10:00:00.000Z');
  });

  it('failure-open — repo error returns ok:false with reason', async () => {
    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointmentThrows: new Error('connection reset'),
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connection reset');
  });

  it('rejects non-positive duration', async () => {
    const finder = new DefaultAvailabilityFinder(buildDeps());

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: 0,
    });

    expect(result.ok).toBe(false);
  });

  it('returns empty slots when window is shorter than duration', async () => {
    const finder = new DefaultAvailabilityFinder(buildDeps());

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T09:30:00Z'),
      durationMs: HOUR,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toEqual([]);
  });

  it('caps count at MAX_SLOT_COUNT (10)', async () => {
    const finder = new DefaultAvailabilityFinder(buildDeps());

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T00:00:00Z'),
      searchTo: new Date('2026-04-21T23:00:00Z'),
      durationMs: HOUR,
      count: 99,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots.length).toBeLessThanOrEqual(10);
  });

  it('snaps slot starts to the granularity grid — 15 min gives 15-min boundaries', async () => {
    const finder = new DefaultAvailabilityFinder(
      buildDeps({
        appointments: [
          makeAppt('a', '2026-04-21T09:00:00Z', '2026-04-21T09:10:00Z'),
        ],
      })
    );

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T11:00:00Z'),
      durationMs: 30 * MIN,
      granularityMs: 15 * MIN,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // First slot after the 09:10 conflict, snapped to 15-min grid → 09:15.
    expect(result.slots[0].start.toISOString()).toBe('2026-04-21T09:15:00.000Z');
  });

  it('fails closed when technicianId is set but no assignmentRepo is wired', async () => {
    const { appointmentRepo } = buildDeps();
    const finder = new DefaultAvailabilityFinder({ appointmentRepo });

    const result = await finder.find({
      tenantId,
      searchFrom: new Date('2026-04-21T09:00:00Z'),
      searchTo: new Date('2026-04-21T17:00:00Z'),
      durationMs: HOUR,
      technicianId,
    });

    expect(result.ok).toBe(false);
  });
});
