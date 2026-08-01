import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreateAppointmentExecutionHandler } from '../../../src/proposals/execution/handlers';
import { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../../src/appointments/assignment';
import { ConflictError } from '../../../src/shared/errors';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';

describe('CreateAppointmentExecutionHandler', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techId = '660e8400-e29b-41d4-a716-446655440001';
  const context = { tenantId, executedBy: 'user-1' };
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  const enqueue = vi.fn(async () => {});

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-1',
      tenantId,
      proposalType: 'create_appointment',
      status: 'approved',
      payload,
      summary: 'Create appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    enqueue.mockClear();
  });

  it('creates appointment, assigns technician, and enqueues confirmation notifications', async () => {
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue },
    );

    const proposal = makeProposal({
      jobId: '11111111-1111-4111-8111-111111111111',
      scheduledStart: '2026-04-20T14:00:00Z',
      scheduledEnd: '2026-04-20T15:00:00Z',
      technicianId: techId,
      notificationChannels: ['sms', 'email'],
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const created = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(created).not.toBeNull();

    const assignments = await assignmentRepo.findByAppointment(tenantId, result.resultEntityId!);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].technicianId).toBe(techId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      appointmentId: result.resultEntityId,
      channels: ['sms', 'email'],
    }));
  });

  it('threads a valid appointmentType from the payload onto the appointment', async () => {
    const handler = new CreateAppointmentExecutionHandler(appointmentRepo, assignmentRepo, {
      enqueue,
    });
    const proposal = makeProposal({
      jobId: '11111111-1111-4111-8111-111111111111',
      scheduledStart: '2026-04-20T14:00:00Z',
      scheduledEnd: '2026-04-20T15:00:00Z',
      appointmentType: 'repair',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const created = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(created!.appointmentType).toBe('repair');
  });

  it('drops an out-of-enum appointmentType rather than forwarding it', async () => {
    const handler = new CreateAppointmentExecutionHandler(appointmentRepo, assignmentRepo, {
      enqueue,
    });
    const proposal = makeProposal({
      jobId: '11111111-1111-4111-8111-111111111111',
      scheduledStart: '2026-04-20T14:00:00Z',
      scheduledEnd: '2026-04-20T15:00:00Z',
      // urgency is not a type — the handler must not persist it
      appointmentType: 'emergency',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const created = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(created!.appointmentType).toBeUndefined();
  });

  it('blocks overlapping technician slots', async () => {
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue },
    );

    const existing = await createAppointment({
      tenantId,
      jobId: '22222222-2222-4222-8222-222222222222',
      scheduledStart: new Date('2026-04-20T14:00:00Z'),
      scheduledEnd: new Date('2026-04-20T15:00:00Z'),
      timezone: 'UTC',
      createdBy: 'user-1',
    }, appointmentRepo);
    await assignTechnician({
      tenantId,
      appointmentId: existing.id,
      technicianId: techId,
      technicianRole: 'technician',
      assignedBy: 'user-1',
    }, assignmentRepo);

    const proposal = makeProposal({
      jobId: '33333333-3333-4333-8333-333333333333',
      scheduledStart: '2026-04-20T14:30:00Z',
      scheduledEnd: '2026-04-20T15:30:00Z',
      technicianId: techId,
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Overlaps with appointment');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('cancels the created appointment when assignment loses the DB double-booking race (no orphan)', async () => {
    // Simulate the TOCTOU race: the pre-flight overlap check passes, but the
    // DB EXCLUDE constraint rejects the assignment INSERT (mapped to
    // ConflictError by PgAssignmentRepository). The handler must compensate
    // by canceling the just-created appointment and reporting failure.
    const racingAssignmentRepo = new InMemoryAssignmentRepository();
    racingAssignmentRepo.create = vi.fn(async () => {
      throw new ConflictError(
        'Technician is already booked at this time (overlaps an existing assignment).',
      );
    });

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      racingAssignmentRepo,
      { enqueue },
    );

    const proposal = makeProposal({
      jobId: '44444444-4444-4444-8444-444444444444',
      scheduledStart: '2026-04-21T09:00:00Z',
      scheduledEnd: '2026-04-21T10:00:00Z',
      technicianId: techId,
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already booked/i);
    expect(enqueue).not.toHaveBeenCalled();

    // The appointment created before the failed assignment must be canceled,
    // not left as an active unassigned orphan.
    const all = await appointmentRepo.findByJob(tenantId, '44444444-4444-4444-8444-444444444444');
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('canceled');
  });

  it('rethrows non-conflict assignment failures after compensating', async () => {
    const failingAssignmentRepo = new InMemoryAssignmentRepository();
    failingAssignmentRepo.create = vi.fn(async () => {
      throw new Error('connection terminated');
    });

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      failingAssignmentRepo,
      { enqueue },
    );

    const proposal = makeProposal({
      jobId: '55555555-5555-4555-8555-555555555555',
      scheduledStart: '2026-04-22T09:00:00Z',
      scheduledEnd: '2026-04-22T10:00:00Z',
      technicianId: techId,
    });

    await expect(handler.execute(proposal, context)).rejects.toThrow('connection terminated');
    const all = await appointmentRepo.findByJob(tenantId, '55555555-5555-4555-8555-555555555555');
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('canceled');
  });

  it('a failing compensation never masks the original conflict, and is audited', async () => {
    const racingAssignmentRepo = new InMemoryAssignmentRepository();
    racingAssignmentRepo.create = vi.fn(async () => {
      throw new ConflictError('Technician is already booked at this time.');
    });
    // Compensation itself fails (e.g. connection dropped mid-cleanup).
    const originalUpdate = appointmentRepo.update.bind(appointmentRepo);
    appointmentRepo.update = vi.fn(async () => {
      throw new Error('connection terminated during compensation');
    });
    const { InMemoryAuditRepository } = await import('../../../src/audit/audit');
    const auditRepo = new InMemoryAuditRepository();

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      racingAssignmentRepo,
      { enqueue },
      auditRepo,
    );

    const proposal = makeProposal({
      jobId: '66666666-6666-4666-8666-666666666666',
      scheduledStart: '2026-04-23T09:00:00Z',
      scheduledEnd: '2026-04-23T10:00:00Z',
      technicianId: techId,
    });

    // The ORIGINAL conflict result is returned even though cleanup failed.
    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already booked/i);

    // The failed compensation is audited so operators can find the orphan.
    const events = auditRepo.events.filter(
      (e: any) => e.eventType === 'appointment.compensation_failed',
    );
    expect(events).toHaveLength(1);

    appointmentRepo.update = originalUpdate;
  });

  it('persists the spoken reason-for-visit from payload.summary when notes is absent', async () => {
    // An inbound cold call has no jobId on the transcript, so the AI task
    // handler skips the held-slot path and emits a plain create_appointment
    // proposal carrying the work description in `summary`. The execution
    // handler must persist that as the appointment notes, not drop it.
    const handler = new CreateAppointmentExecutionHandler(appointmentRepo);

    const proposal = makeProposal({
      jobId: '77777777-7777-4777-8777-777777777777',
      scheduledStart: '2026-04-24T14:00:00Z',
      scheduledEnd: '2026-04-24T15:00:00Z',
      summary: 'Leaking water heater',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const created = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(created?.notes).toBe('Leaking water heater');
  });

  it('prefers an explicit notes field over summary', async () => {
    const handler = new CreateAppointmentExecutionHandler(appointmentRepo);

    const proposal = makeProposal({
      jobId: '88888888-8888-4888-8888-888888888888',
      scheduledStart: '2026-04-25T14:00:00Z',
      scheduledEnd: '2026-04-25T15:00:00Z',
      notes: 'Dispatcher note',
      summary: 'Leaking water heater',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const created = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(created?.notes).toBe('Dispatcher note');
  });

  it('emits exactly one appointment.created audit event on execute (production audit fix)', async () => {
    // Regression guard: the handler forwards this.auditRepo into
    // createAppointment; before the fix it was silently dropped, so no
    // appointment.created audit event was emitted on the proposal-execution
    // path even though the appointment persisted.
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue },
      auditRepo,
    );

    const proposal = makeProposal({
      jobId: '99999999-9999-4999-8999-999999999999',
      scheduledStart: '2026-04-26T14:00:00Z',
      scheduledEnd: '2026-04-26T15:00:00Z',
    });

    const result = await handler.execute(proposal, context);
    expect(result.success).toBe(true);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'appointment.created');
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(result.resultEntityId);
  });
});

// Foundation gate F2 / contract #12-#13 (Codex round 5) — the proposal path
// was the one assignment surface that skipped the availability preconditions.
describe('CreateAppointmentExecutionHandler — availability preconditions', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techId = '660e8400-e29b-41d4-a716-446655440001';
  const context = { tenantId, executedBy: 'user-1' };

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-av',
      tenantId,
      proposalType: 'create_appointment',
      status: 'approved',
      payload,
      summary: 'Create appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  // Tuesday-only tech (dayOfWeek 2), 08:00-17:00.
  const availabilityRepos = {
    workingHoursRepo: {
      findByTechnician: async () => [{
        id: 'wh-2', tenantId, technicianId: techId,
        dayOfWeek: 2, startTime: '08:00', endTime: '17:00', isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      }],
    },
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] },
  } as never;

  it('rejects a proposal window on a modeled day off, creating nothing', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo, assignmentRepo, { enqueue: async () => {} },
      undefined, undefined, availabilityRepos,
    );
    // 2026-04-20 is a Monday — the tech is Tuesday-only.
    const result = await handler.execute(
      makeProposal({
        jobId: '11111111-1111-4111-8111-111111111111',
        scheduledStart: '2026-04-20T14:00:00Z',
        scheduledEnd: '2026-04-20T15:00:00Z',
        timezone: 'UTC',
        technicianId: techId,
      }),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not scheduled to work/i);
    // Early rejection — no orphan appointment was created and compensated.
    const appts = await appointmentRepo.findByDateRange(
      tenantId, new Date('2026-04-19T00:00:00Z'), new Date('2026-04-22T00:00:00Z'),
    );
    expect(appts).toHaveLength(0);
  });

  it('executes a proposal window inside the modeled hours', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo, assignmentRepo, { enqueue: async () => {} },
      undefined, undefined, availabilityRepos,
    );
    // 2026-04-21 is a Tuesday, 14:00-15:00 UTC inside 08:00-17:00.
    const result = await handler.execute(
      makeProposal({
        jobId: '11111111-1111-4111-8111-111111111111',
        scheduledStart: '2026-04-21T14:00:00Z',
        scheduledEnd: '2026-04-21T15:00:00Z',
        timezone: 'UTC',
        technicianId: techId,
      }),
      context,
    );
    expect(result.success).toBe(true);
  });
});

// Codex (PR #741): a payload without `timezone` must resolve the TENANT zone
// before the availability check — a UTC default evaluates the wrong local day
// for non-UTC tenants.
describe('CreateAppointmentExecutionHandler — tenant-timezone fallback', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const techId = '660e8400-e29b-41d4-a716-446655440001';
  const context = { tenantId, executedBy: 'user-1' };

  // Mon-Fri 08:00-17:00 EASTERN tech.
  const availabilityRepos = {
    workingHoursRepo: {
      findByTechnician: async () => [1, 2, 3, 4, 5].map((d) => ({
        id: `wh-${d}`, tenantId, technicianId: techId,
        dayOfWeek: d, startTime: '08:00', endTime: '17:00', isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      })),
    },
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] },
  } as never;
  const settingsRepo = {
    findByTenant: async () => ({ timezone: 'America/New_York' }),
  } as never;

  it('accepts an in-hours Eastern window that a UTC evaluation would reject', async () => {
    const handler = new CreateAppointmentExecutionHandler(
      new InMemoryAppointmentRepository(),
      new InMemoryAssignmentRepository(),
      { enqueue: async () => {} },
      undefined, undefined, availabilityRepos, settingsRepo,
    );
    // Tue 2026-04-21 20:00-21:00Z = 16:00-17:00 EDT (inside hours).
    // Evaluated as UTC it is 20:00-21:00 local — outside 08:00-17:00.
    const result = await handler.execute(
      {
        id: 'prop-tz', tenantId, proposalType: 'create_appointment', status: 'approved',
        payload: {
          jobId: '11111111-1111-4111-8111-111111111111',
          scheduledStart: '2026-04-21T20:00:00Z',
          scheduledEnd: '2026-04-21T21:00:00Z',
          technicianId: techId,
          // no timezone in payload — must come from tenant settings
        },
        summary: 'Create appointment', createdBy: 'user-1',
        createdAt: new Date(), updatedAt: new Date(),
      } as Proposal,
      context,
    );
    expect(result.success).toBe(true);
  });
});

// SCH-02 — a caller describing NEW work ("book an appointment for a furnace
// tune-up") is classified with entities.jobTitle and no resolvable jobId
// (create_appointment deliberately never fuzzy-searches jobTitle as an
// existing-job reference — see entity-resolution.ts). Without a fallback
// this hard-failed every time. The handler now auto-opens a job from
// jobTitle + the already-resolved customerId when jobRepo/locationRepo are
// wired, matching how a human dispatcher would handle the call.
describe('CreateAppointmentExecutionHandler — jobTitle-no-jobId auto-open-a-job fallback', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const customerId = '660e8400-e29b-41d4-a716-446655440099';
  const context = { tenantId, executedBy: 'user-1' };

  function makeProposal(payload: Record<string, unknown>): Proposal {
    return {
      id: 'prop-sch02',
      tenantId,
      proposalType: 'create_appointment',
      status: 'approved',
      payload,
      summary: 'Create appointment',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async function makeLocationRepo() {
    const locationRepo = new InMemoryLocationRepository();
    await createLocation(
      {
        tenantId,
        customerId,
        street1: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        postalCode: '90210',
        isPrimary: true,
      },
      locationRepo,
    );
    return locationRepo;
  }

  it('auto-creates a job from jobTitle + customerId and books against it when jobId is absent', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = await makeLocationRepo();

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        jobTitle: 'Furnace tune-up',
        customerId,
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const jobs = await jobRepo.findByTenant(tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].customerId).toBe(customerId);
    expect(jobs[0].summary).toBe('Furnace tune-up');

    const appointment = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(appointment?.jobId).toBe(jobs[0].id);
  });

  // THE regression guard for the SMS-01/SCH-02 flake. `jobTitle` is an
  // LLM-extracted entity the classifier emits only most of the time
  // (measured 39/40 on the SMS-01 utterance), so gating the auto-open block
  // on it made every voice booking a dice roll: on a miss, execution
  // hard-failed with "Payload must include a valid jobId" and the caller's
  // booking was silently dropped. The block now runs on customerId alone
  // and names the job from the always-present `proposal.summary`.
  it('auto-creates a job named proposal.summary when customerId is present but jobTitle is ABSENT', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const assignmentRepo = new InMemoryAssignmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = await makeLocationRepo();

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      assignmentRepo,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        // no jobId, no jobTitle — the classifier-miss case
        customerId,
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const jobs = await jobRepo.findByTenant(tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].customerId).toBe(customerId);
    // Falls back to the proposal summary — never empty (non-optional on
    // Proposal; buildProposal rejects an empty one).
    expect(jobs[0].summary).toBe('Create appointment');

    const appointment = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(appointment?.jobId).toBe(jobs[0].id);
    // Step 3 — the notes cascade also terminates in an always-present value,
    // so a voice booking no longer persists a blank reason-for-visit.
    expect(appointment?.notes).toBe('Create appointment');
  });

  it('names the job from jobTitle when it IS present (behaviour unchanged) and notes it as the reason', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = await makeLocationRepo();

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        jobTitle: 'Furnace tune-up',
        customerId,
        scheduledStart: '2026-08-02T14:00:00Z',
        scheduledEnd: '2026-08-02T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(true);
    const jobs = await jobRepo.findByTenant(tenantId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].summary).toBe('Furnace tune-up');

    const appointment = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(appointment?.notes).toBe('Furnace tune-up');
  });

  it('still returns the service-location error when the customer has no location', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    // Empty location repo — the customer exists but has no service location.
    const locationRepo = new InMemoryLocationRepository();

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        customerId,
        scheduledStart: '2026-08-03T14:00:00Z',
        scheduledEnd: '2026-08-03T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Customer has no service location — add one before booking a new job',
    );
    expect(await jobRepo.findByTenant(tenantId)).toHaveLength(0);
  });

  it('still hard-fails when there is no jobId AND no customerId (unchanged baseline behavior)', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = await makeLocationRepo();
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload must include a valid jobId');
  });

  it('is a distinct expected failure when jobTitle is present but customerId is absent', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = await makeLocationRepo();
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        jobTitle: 'Furnace tune-up',
        // no customerId
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload must include a valid jobId');
    expect(await jobRepo.findByTenant(tenantId)).toHaveLength(0);
  });

  it('does not attempt job auto-creation without jobRepo/locationRepo wired (degrades to original hard-fail)', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      { enqueue: async () => {} },
    );

    const result = await handler.execute(
      makeProposal({
        jobTitle: 'Furnace tune-up',
        customerId,
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Payload must include a valid jobId');
  });

  it('a linkedJobId revisit is unaffected by the jobTitle fallback (existing-job path wins)', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = await makeLocationRepo();
    const existingJob = await jobRepo.create({
      id: 'existing-job-1',
      tenantId,
      customerId,
      locationId: 'loc-1',
      jobNumber: 'JOB-0001',
      summary: 'Existing job',
      status: 'new',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      moneyState: 'no_estimate',
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      { enqueue: async () => {} },
      undefined,
      jobRepo,
      undefined,
      undefined,
      locationRepo,
    );

    const result = await handler.execute(
      makeProposal({
        linkedJobId: existingJob.id,
        jobTitle: 'Furnace tune-up', // present, but must be ignored — linkedJobId wins
        customerId,
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(true);
    const appointment = await appointmentRepo.findById(tenantId, result.resultEntityId!);
    expect(appointment?.jobId).toBe(existingJob.id);
    // No new job was created — only the pre-existing one.
    expect(await jobRepo.findByTenant(tenantId)).toHaveLength(1);
  });
});
