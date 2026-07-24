import {
  assignTechnician,
  unassignTechnician,
  getAssignments,
  syncJobAssignment,
  validateAssignmentInput,
  InMemoryAssignmentRepository,
} from '../../src/appointments/assignment';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import { createAppointment } from '../../src/appointments/appointment';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-008 — Technician assignment model', () => {
  let assignmentRepo: InMemoryAssignmentRepository;
  let jobRepo: InMemoryJobRepository;

  beforeEach(() => {
    assignmentRepo = new InMemoryAssignmentRepository();
    jobRepo = new InMemoryJobRepository();
  });

  it('happy path — assigns technician to appointment', async () => {
    const assignment = await assignTechnician(
      {
        tenantId: 'tenant-1',
        appointmentId: 'apt-1',
        technicianId: 'tech-1',
        technicianRole: 'technician',
        assignedBy: 'dispatcher-1',
      },
      assignmentRepo
    );

    expect(assignment.id).toBeTruthy();
    expect(assignment.technicianId).toBe('tech-1');
    expect(assignment.isPrimary).toBe(true);
  });

  it('happy path — assigning a new primary demotes existing primary', async () => {
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-2', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    const assignments = await getAssignments('tenant-1', 'apt-1', assignmentRepo);
    const primaryAssignments = assignments.filter((assignment) => assignment.isPrimary);

    expect(primaryAssignments).toHaveLength(1);
    expect(primaryAssignments[0].technicianId).toBe('tech-2');
  });

  it('happy path — retrieves assignments for appointment', async () => {
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-2', technicianRole: 'technician', isPrimary: false, assignedBy: 'disp-1' },
      assignmentRepo
    );

    const assignments = await getAssignments('tenant-1', 'apt-1', assignmentRepo);
    expect(assignments).toHaveLength(2);
  });

  it('happy path — unassigns technician', async () => {
    const assignment = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    const result = await unassignTechnician('tenant-1', assignment.id, assignmentRepo);
    expect(result).toBe(true);

    const remaining = await getAssignments('tenant-1', 'apt-1', assignmentRepo);
    expect(remaining).toHaveLength(0);
  });

  it('happy path — syncs job assignment from appointment', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);

    const updatedJob = await jobRepo.findById('tenant-1', job.id);
    expect(updatedJob!.assignedTechnicianId).toBe('tech-1');
  });

  it('validation — rejects non-technician role', () => {
    const errors = validateAssignmentInput({
      tenantId: 'tenant-1',
      appointmentId: 'apt-1',
      technicianId: 'user-1',
      technicianRole: 'dispatcher',
      assignedBy: 'owner-1',
    });
    expect(errors).toContain('Assigned user must have technician role');
  });

  it('validation — assignTechnician rejects non-technician role', async () => {
    await expect(
      assignTechnician(
        {
          tenantId: 'tenant-1',
          appointmentId: 'apt-1',
          technicianId: 'user-1',
          technicianRole: 'dispatcher',
          assignedBy: 'owner-1',
        },
        assignmentRepo
      )
    ).rejects.toThrow('Assigned user must have technician role');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateAssignmentInput({
      tenantId: '',
      appointmentId: '',
      technicianId: '',
      technicianRole: 'technician',
      assignedBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('appointmentId is required');
    expect(errors).toContain('technicianId is required');
    expect(errors).toContain('assignedBy is required');
  });

  it('validation — assignTechnician surfaces validator errors', async () => {
    await expect(
      assignTechnician(
        {
          tenantId: 'tenant-1',
          appointmentId: 'apt-1',
          technicianId: 'user-1',
          technicianRole: 'dispatcher',
          assignedBy: 'owner-1',
        },
        assignmentRepo
      )
    ).rejects.toThrow('Validation failed: Assigned user must have technician role');
  });

  it('edge case — syncJobAssignment clears stale technician when no primary', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    const assignment = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );
    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);
    expect((await jobRepo.findById('tenant-1', job.id))!.assignedTechnicianId).toBe('tech-1');

    await unassignTechnician('tenant-1', assignment.id, assignmentRepo);
    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);
    const updatedJob = await jobRepo.findById('tenant-1', job.id);
    expect(updatedJob!.assignedTechnicianId).toBeUndefined();
  });

  it('edge case — syncJobAssignment deterministically keeps a single primary when multiple exist', async () => {
    const job = await createJob(
      { tenantId: 'tenant-1', customerId: 'c-1', locationId: 'l-1', summary: 'Test', createdBy: 'u-1' },
      jobRepo
    );

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1', isPrimary: true },
      assignmentRepo
    );
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-2', technicianRole: 'technician', assignedBy: 'disp-1', isPrimary: true },
      assignmentRepo
    );

    await syncJobAssignment('tenant-1', job.id, 'apt-1', assignmentRepo, jobRepo);

    const updatedJob = await jobRepo.findById('tenant-1', job.id);
    expect(updatedJob!.assignedTechnicianId).toBe('tech-2');

    const assignments = await getAssignments('tenant-1', 'apt-1', assignmentRepo);
    const primaryAssignments = assignments.filter((assignment) => assignment.isPrimary);
    expect(primaryAssignments).toHaveLength(1);
    expect(primaryAssignments[0].technicianId).toBe('tech-2');
  });

  it('tenant isolation — cross-tenant assignment inaccessible', async () => {
    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo
    );

    const crossTenant = await getAssignments('tenant-2', 'apt-1', assignmentRepo);
    expect(crossTenant).toHaveLength(0);
  });
});

describe('Blocker 7 — assignment audit + double-booking guard', () => {
  let assignmentRepo: InMemoryAssignmentRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    assignmentRepo = new InMemoryAssignmentRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const makeAppt = (start: string, end: string) =>
    createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: new Date(start),
        scheduledEnd: new Date(end),
        timezone: 'America/Los_Angeles',
        createdBy: 'disp-1',
      },
      appointmentRepo,
    );

  it('emits appointment.technician_assigned audit event', async () => {
    const created = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
      { auditRepo, actorRole: 'dispatcher' },
    );

    const ev = auditRepo.getAll().find((e) => e.eventType === 'appointment.technician_assigned');
    expect(ev).toBeDefined();
    expect(ev!.entityType).toBe('appointment');
    expect(ev!.entityId).toBe('apt-1');
    expect(ev!.actorId).toBe('disp-1');
    expect(ev!.actorRole).toBe('dispatcher');
    expect(ev!.metadata).toMatchObject({ technicianId: 'tech-1', assignmentId: created.id });
  });

  it('emits appointment.technician_unassigned audit event on removal', async () => {
    const a = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: 'apt-1', technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
    );
    const removed = await unassignTechnician('tenant-1', a.id, assignmentRepo, {
      auditRepo,
      actorId: 'disp-1',
      appointmentId: 'apt-1',
      technicianId: 'tech-1',
    });

    expect(removed).toBe(true);
    const ev = auditRepo.getAll().find((e) => e.eventType === 'appointment.technician_unassigned');
    expect(ev).toBeDefined();
    expect(ev!.metadata).toMatchObject({ technicianId: 'tech-1', assignmentId: a.id });
  });

  it('does not emit an unassigned event when nothing was removed', async () => {
    const removed = await unassignTechnician('tenant-1', 'missing-id', assignmentRepo, {
      auditRepo,
      actorId: 'disp-1',
    });
    expect(removed).toBe(false);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('throws ConflictError (409) when the technician already has an overlapping active appointment', async () => {
    const appt1 = await makeAppt('2026-06-01T17:00:00Z', '2026-06-01T19:00:00Z');
    const appt2 = await makeAppt('2026-06-01T18:00:00Z', '2026-06-01T20:00:00Z'); // overlaps appt1

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: appt1.id, technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
    );

    await expect(
      assignTechnician(
        { tenantId: 'tenant-1', appointmentId: appt2.id, technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
        assignmentRepo,
        { appointmentRepo },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows assignment to an adjacent, non-overlapping appointment', async () => {
    const appt1 = await makeAppt('2026-06-01T17:00:00Z', '2026-06-01T18:00:00Z');
    const appt2 = await makeAppt('2026-06-01T18:00:00Z', '2026-06-01T19:00:00Z'); // touches but does not overlap

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: appt1.id, technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
    );

    const ok = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: appt2.id, technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
      { appointmentRepo },
    );
    expect(ok.technicianId).toBe('tech-1');
  });

  it('does not block when the overlapping appointment is canceled', async () => {
    const appt1 = await makeAppt('2026-06-01T17:00:00Z', '2026-06-01T19:00:00Z');
    const appt2 = await makeAppt('2026-06-01T18:00:00Z', '2026-06-01T20:00:00Z');

    await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: appt1.id, technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
    );
    // Cancel appt1 — a canceled appointment must not block (its slot is freed).
    await appointmentRepo.update('tenant-1', appt1.id, { status: 'canceled' });

    const ok = await assignTechnician(
      { tenantId: 'tenant-1', appointmentId: appt2.id, technicianId: 'tech-1', technicianRole: 'technician', assignedBy: 'disp-1' },
      assignmentRepo,
      { appointmentRepo },
    );
    expect(ok.technicianId).toBe('tech-1');
  });
});

// Foundation gate F2 / contract #12-#13 — availability preconditions on
// assignment: refuse windows outside the tech's MODELED working hours or
// during time-off; a tech nobody modeled stays unconstrained.
describe('assignTechnician — working-hours + time-off preconditions', () => {
  let assignmentRepo: InMemoryAssignmentRepository;
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    assignmentRepo = new InMemoryAssignmentRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
  });

  // Monday 2026-06-15, 10:00–11:00 PT (17:00–18:00Z).
  const makeAppt = () =>
    createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: new Date('2026-06-15T17:00:00Z'),
        scheduledEnd: new Date('2026-06-15T18:00:00Z'),
        timezone: 'America/Los_Angeles',
        createdBy: 'disp-1',
      },
      appointmentRepo,
    );

  const input = (appointmentId: string) => ({
    tenantId: 'tenant-1',
    appointmentId,
    technicianId: 'tech-1',
    technicianRole: 'technician',
    assignedBy: 'disp-1',
  });

  const whRepo = (rows: unknown[]) =>
    ({ findByTechnician: async () => rows }) as never;
  const blockRepo = (blocks: unknown[]) =>
    ({ findByTechnicianAndDateRange: async () => blocks }) as never;
  const row = (dayOfWeek: number, startTime: string, endTime: string, isActive = true) => ({
    id: `wh-${dayOfWeek}`, tenantId: 'tenant-1', technicianId: 'tech-1',
    dayOfWeek, startTime, endTime, isActive,
    createdAt: new Date(), updatedAt: new Date(),
  });

  it('assigns when the window fits the modeled hours (weekday resolved in appt tz)', async () => {
    const appt = await makeAppt();
    const a = await assignTechnician(input(appt.id), assignmentRepo, {
      appointmentRepo,
      workingHoursRepo: whRepo([row(1, '08:00', '17:00')]), // Monday PT
      unavailableBlockRepo: blockRepo([]),
    });
    expect(a.technicianId).toBe('tech-1');
  });

  it('refuses a window outside the modeled hours', async () => {
    const appt = await makeAppt(); // 10:00 PT start
    await expect(
      assignTechnician(input(appt.id), assignmentRepo, {
        appointmentRepo,
        workingHoursRepo: whRepo([row(1, '12:00', '17:00')]),
      }),
    ).rejects.toThrow(/working hours/i);
  });

  it('refuses a modeled-but-off-day assignment', async () => {
    const appt = await makeAppt(); // Monday
    await expect(
      assignTechnician(input(appt.id), assignmentRepo, {
        appointmentRepo,
        workingHoursRepo: whRepo([row(2, '08:00', '17:00')]), // Tuesday-only tech
      }),
    ).rejects.toThrow(/not scheduled to work/i);
  });

  it('leaves an unmodeled technician unconstrained', async () => {
    const appt = await makeAppt();
    const a = await assignTechnician(input(appt.id), assignmentRepo, {
      appointmentRepo,
      workingHoursRepo: whRepo([]),
      unavailableBlockRepo: blockRepo([]),
    });
    expect(a.technicianId).toBe('tech-1');
  });

  it('refuses an assignment overlapping a time-off block', async () => {
    const appt = await makeAppt();
    await expect(
      assignTechnician(input(appt.id), assignmentRepo, {
        appointmentRepo,
        unavailableBlockRepo: blockRepo([
          {
            id: 'b-1', tenantId: 'tenant-1', technicianId: 'tech-1',
            startTime: new Date('2026-06-15T17:30:00Z'),
            endTime: new Date('2026-06-15T19:00:00Z'),
            reason: 'PTO', createdBy: 'disp-1', createdAt: new Date(),
          },
        ]),
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('ignores inactive working-hours rows', async () => {
    const appt = await makeAppt();
    const a = await assignTechnician(input(appt.id), assignmentRepo, {
      appointmentRepo,
      workingHoursRepo: whRepo([row(1, '12:00', '17:00', false)]),
    });
    expect(a.technicianId).toBe('tech-1');
  });
});

describe('assignTechnician — cross-midnight windows vs modeled hours (Codex P2)', () => {
  it('refuses a window spanning local days for a modeled technician', async () => {
    const assignmentRepo = new InMemoryAssignmentRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    // Monday 16:00 PT → Tuesday 09:00 PT; minutes-of-day comparison alone
    // would pass a Monday 08:00–17:00 row.
    const appt = await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        scheduledStart: new Date('2026-06-15T23:00:00Z'), // Mon 16:00 PT
        scheduledEnd: new Date('2026-06-16T16:00:00Z'), // Tue 09:00 PT
        timezone: 'America/Los_Angeles',
        createdBy: 'disp-1',
      },
      appointmentRepo,
    );
    await expect(
      assignTechnician(
        {
          tenantId: 'tenant-1',
          appointmentId: appt.id,
          technicianId: 'tech-1',
          technicianRole: 'technician',
          assignedBy: 'disp-1',
        },
        assignmentRepo,
        {
          appointmentRepo,
          workingHoursRepo: {
            findByTechnician: async () => [{
              id: 'wh-1', tenantId: 'tenant-1', technicianId: 'tech-1',
              dayOfWeek: 1, startTime: '08:00', endTime: '17:00', isActive: true,
              createdAt: new Date(), updatedAt: new Date(),
            }],
          } as never,
        },
      ),
    ).rejects.toThrow(/spans multiple local days/i);
  });
});
