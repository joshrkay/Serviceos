/**
 * SlotConflictChecker unit tests (P0-035).
 *
 * Covers the pre-draft availability check that prevents the AI task
 * router from emitting `create_appointment` proposals against busy
 * slots. See `slot-conflict-checker.ts` for the design notes.
 */
import { describe, it, expect, vi } from 'vitest';
import { DefaultSlotConflictChecker } from '../../../src/ai/tasks/slot-conflict-checker';
import {
  Appointment,
  AppointmentRepository,
} from '../../../src/appointments/appointment';
import {
  AppointmentAssignment,
  AssignmentRepository,
} from '../../../src/appointments/assignment';
import { Job, JobRepository } from '../../../src/jobs/job';

const tenantId = 'tenant-1';
const technicianId = 'tech-1';
const otherTechId = 'tech-2';
const customerId = 'cust-1';
const otherCustomerId = 'cust-2';

function makeAppointment(overrides: Partial<Appointment>): Appointment {
  return {
    id: 'appt-1',
    tenantId,
    jobId: 'job-1',
    scheduledStart: new Date('2026-04-21T10:00:00Z'),
    scheduledEnd: new Date('2026-04-21T11:00:00Z'),
    timezone: 'UTC',
    status: 'scheduled',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<AppointmentAssignment>): AppointmentAssignment {
  return {
    id: 'asg-1',
    tenantId,
    appointmentId: 'appt-1',
    technicianId,
    isPrimary: true,
    assignedBy: 'user-1',
    assignedAt: new Date(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    tenantId,
    customerId,
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 's',
    status: 'new',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface StubDeps {
  appointments: Appointment[];
  assignmentsByAppt: Map<string, AppointmentAssignment[]>;
  jobsById: Map<string, Job>;
  appointmentRepoThrows?: Error;
  assignmentRepoThrows?: Error;
  jobRepoThrows?: Error;
}

function buildStubs(opts: StubDeps): {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo: JobRepository;
} {
  const appointmentRepo: AppointmentRepository = {
    create: vi.fn(),
    findById: vi.fn(async (tid, id) => opts.appointments.find((a) => a.tenantId === tid && a.id === id) ?? null),
    findByJob: vi.fn(),
    findByDateRange: vi.fn(async (tid: string, from: Date, to: Date) => {
      if (opts.appointmentRepoThrows) throw opts.appointmentRepoThrows;
      return opts.appointments.filter(
        (a) => a.tenantId === tid && a.scheduledStart >= from && a.scheduledStart <= to
      );
    }),
    update: vi.fn(),
  };

  const assignmentRepo: AssignmentRepository = {
    create: vi.fn(),
    update: vi.fn(),
    findByAppointment: vi.fn(async (tid: string, appointmentId: string) => {
      if (opts.assignmentRepoThrows) throw opts.assignmentRepoThrows;
      return opts.assignmentsByAppt.get(appointmentId) ?? [];
    }),
    findByTechnician: vi.fn(),
    delete: vi.fn(),
  };

  const jobRepo: JobRepository = {
    create: vi.fn(),
    findById: vi.fn(async (tid: string, id: string) => {
      if (opts.jobRepoThrows) throw opts.jobRepoThrows;
      const j = opts.jobsById.get(id);
      return j && j.tenantId === tid ? j : null;
    }),
    findByTenant: vi.fn(),
    update: vi.fn(),
    getNextJobNumber: vi.fn(),
  };

  return { appointmentRepo, assignmentRepo, jobRepo };
}

describe('SlotConflictChecker (P0-035)', () => {
  it('happy path — non-conflicting slot returns ok:true', async () => {
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [],
      assignmentsByAppt: new Map(),
      jobsById: new Map(),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T14:00:00Z'),
      windowEnd: new Date('2026-04-21T15:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({ ok: true });
  });

  it('technician busy — overlapping appointment for same tech returns technician_busy', async () => {
    const existing = makeAppointment({
      id: 'appt-existing',
      jobId: 'job-other',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      assignmentsByAppt: new Map([
        ['appt-existing', [makeAssignment({ appointmentId: 'appt-existing', technicianId })]],
      ]),
      // The other appointment is for a different customer.
      jobsById: new Map([['job-other', makeJob({ id: 'job-other', customerId: otherCustomerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-existing',
      conflictWindow: {
        start: existing.scheduledStart,
        end: existing.scheduledEnd,
      },
    });
  });

  it('customer busy — overlapping appointment for same customer (different tech) returns customer_busy', async () => {
    const existing = makeAppointment({
      id: 'appt-existing',
      jobId: 'job-cust',
      scheduledStart: new Date('2026-04-21T11:30:00Z'),
      scheduledEnd: new Date('2026-04-21T12:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      assignmentsByAppt: new Map([
        ['appt-existing', [makeAssignment({ appointmentId: 'appt-existing', technicianId: otherTechId })]],
      ]),
      jobsById: new Map([['job-cust', makeJob({ id: 'job-cust', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({
      ok: false,
      conflict: 'customer_busy',
      appointmentId: 'appt-existing',
      conflictWindow: {
        start: existing.scheduledStart,
        end: existing.scheduledEnd,
      },
    });
  });

  it('10:00-11:00 does not conflict with 11:00-12:00 (exclusive boundaries)', async () => {
    const existing = makeAppointment({
      id: 'appt-existing',
      scheduledStart: new Date('2026-04-21T10:00:00Z'),
      scheduledEnd: new Date('2026-04-21T11:00:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      assignmentsByAppt: new Map([
        ['appt-existing', [makeAssignment({ appointmentId: 'appt-existing', technicianId })]],
      ]),
      jobsById: new Map([['job-1', makeJob({ id: 'job-1', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    // Boundary-touching windows must NOT conflict — 10:00-11:00 ends
    // at the same instant 11:00-12:00 begins, so the tech is free.
    expect(result).toEqual({ ok: true });
  });

  it('both busy — surfaces the technician conflict (more actionable for dispatcher)', async () => {
    const existing = makeAppointment({
      id: 'appt-existing',
      jobId: 'job-cust',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      // Same tech AND same customer on the existing appointment.
      assignmentsByAppt: new Map([
        ['appt-existing', [makeAssignment({ appointmentId: 'appt-existing', technicianId })]],
      ]),
      jobsById: new Map([['job-cust', makeJob({ id: 'job-cust', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflict).toBe('technician_busy');
  });

  it('unassigned tech — only the customer-busy check applies; technician-busy is skipped', async () => {
    // Existing tech assignment that would normally collide if we were
    // asked about that tech — but we pass technicianId=undefined.
    const existing = makeAppointment({
      id: 'appt-existing',
      jobId: 'job-other',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      assignmentsByAppt: new Map([
        ['appt-existing', [makeAssignment({ appointmentId: 'appt-existing', technicianId })]],
      ]),
      jobsById: new Map([['job-other', makeJob({ id: 'job-other', customerId: otherCustomerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId: undefined, // unassigned
      customerId,
    });

    // No customer collision either → ok.
    expect(result).toEqual({ ok: true });
    // Technician check must be skipped — assignment lookups should not happen.
    expect(assignmentRepo.findByAppointment).not.toHaveBeenCalled();
  });

  it('unassigned tech — customer collision still surfaces', async () => {
    const existing = makeAppointment({
      id: 'appt-existing',
      jobId: 'job-cust',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      assignmentsByAppt: new Map(),
      jobsById: new Map([['job-cust', makeJob({ id: 'job-cust', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId: undefined,
      customerId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflict).toBe('customer_busy');
  });

  it('repo error — surfaces could_not_verify (failure-open) rather than throwing', async () => {
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [],
      assignmentsByAppt: new Map(),
      jobsById: new Map(),
      appointmentRepoThrows: new Error('database unreachable'),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({
      ok: false,
      conflict: 'could_not_verify',
      reason: 'database unreachable',
    });
  });

  it('overlapping appointment for unrelated tech and unrelated customer is ignored', async () => {
    const existing = makeAppointment({
      id: 'appt-existing',
      jobId: 'job-other',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [existing],
      assignmentsByAppt: new Map([
        ['appt-existing', [makeAssignment({ appointmentId: 'appt-existing', technicianId: otherTechId })]],
      ]),
      jobsById: new Map([['job-other', makeJob({ id: 'job-other', customerId: otherCustomerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({ ok: true });
  });

  it('canceled appointment in the same window does NOT trigger technician_busy (PR #201 status-filter follow-up)', async () => {
    // A canceled appointment shouldn't block a new booking — it doesn't
    // actually occupy the slot. Same setup as the technician_busy case
    // but with status='canceled'; expect ok: true.
    const canceled = makeAppointment({
      id: 'appt-canceled',
      jobId: 'job-1',
      status: 'canceled',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [canceled],
      assignmentsByAppt: new Map([
        ['appt-canceled', [makeAssignment({ appointmentId: 'appt-canceled', technicianId })]],
      ]),
      jobsById: new Map([['job-1', makeJob({ id: 'job-1', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({ ok: true });
  });

  it('completed appointment does NOT trigger conflict', async () => {
    const completed = makeAppointment({
      id: 'appt-completed',
      jobId: 'job-1',
      status: 'completed',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [completed],
      assignmentsByAppt: new Map([
        ['appt-completed', [makeAssignment({ appointmentId: 'appt-completed', technicianId })]],
      ]),
      jobsById: new Map([['job-1', makeJob({ id: 'job-1', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({ ok: true });
  });

  it('no_show appointment does NOT trigger conflict', async () => {
    const noShow = makeAppointment({
      id: 'appt-noshow',
      jobId: 'job-1',
      status: 'no_show',
      scheduledStart: new Date('2026-04-21T10:30:00Z'),
      scheduledEnd: new Date('2026-04-21T11:30:00Z'),
    });
    const { appointmentRepo, assignmentRepo, jobRepo } = buildStubs({
      appointments: [noShow],
      assignmentsByAppt: new Map([
        ['appt-noshow', [makeAssignment({ appointmentId: 'appt-noshow', technicianId })]],
      ]),
      jobsById: new Map([['job-1', makeJob({ id: 'job-1', customerId })]]),
    });
    const checker = new DefaultSlotConflictChecker({ appointmentRepo, assignmentRepo, jobRepo });

    const result = await checker.check({
      tenantId,
      windowStart: new Date('2026-04-21T11:00:00Z'),
      windowEnd: new Date('2026-04-21T12:00:00Z'),
      technicianId,
      customerId,
    });

    expect(result).toEqual({ ok: true });
  });
});
