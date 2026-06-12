/**
 * RV-081 — revisit linkage: a create_appointment proposal carrying
 * `linkedJobId` books an appointment against an EXISTING job (no new job).
 * The handler validates the job exists tenant-scoped, attaches the
 * appointment to it, and audits the revisit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CreateAppointmentExecutionHandler } from '../../../src/proposals/execution/handlers';
import { createAppointmentPayloadSchema } from '../../../src/proposals/contracts';
import type { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../../src/appointments/appointment';
import { InMemoryJobRepository, Job } from '../../../src/jobs/job';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_TENANT = '770e8400-e29b-41d4-a716-446655440099';
const EXISTING_JOB_ID = '11111111-1111-4111-8111-111111111111';
const PLACEHOLDER_JOB_ID = '22222222-2222-4222-8222-222222222222';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: EXISTING_JOB_ID,
    tenantId: TENANT,
    customerId: '33333333-3333-4333-8333-333333333333',
    locationId: '44444444-4444-4444-8444-444444444444',
    jobNumber: 'JOB-0042',
    summary: 'Water heater install',
    status: 'completed',
    priority: 'normal',
    createdBy: 'u-1',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  } as Job;
}

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop-revisit-1',
    tenantId: TENANT,
    proposalType: 'create_appointment',
    status: 'approved',
    payload,
    summary: 'Book revisit',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const basePayload = {
  jobId: PLACEHOLDER_JOB_ID,
  linkedJobId: EXISTING_JOB_ID,
  scheduledStart: '2026-06-20T14:00:00Z',
  scheduledEnd: '2026-06-20T15:00:00Z',
};

describe('createAppointmentPayloadSchema linkedJobId (RV-081)', () => {
  it('accepts an optional linkedJobId uuid', () => {
    expect(createAppointmentPayloadSchema.safeParse(basePayload).success).toBe(true);
  });

  it('rejects a non-uuid linkedJobId', () => {
    expect(
      createAppointmentPayloadSchema.safeParse({ ...basePayload, linkedJobId: 'job-42' }).success,
    ).toBe(false);
  });

  it('remains valid without linkedJobId (back-compat)', () => {
    const { linkedJobId: _omit, ...rest } = basePayload;
    expect(createAppointmentPayloadSchema.safeParse(rest).success).toBe(true);
  });
});

describe('CreateAppointmentExecutionHandler revisit linkage (RV-081)', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let jobRepo: InMemoryJobRepository;
  let auditRepo: InMemoryAuditRepository;
  let handler: CreateAppointmentExecutionHandler;
  const context = { tenantId: TENANT, executedBy: 'user-1' };

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    jobRepo = new InMemoryJobRepository();
    auditRepo = new InMemoryAuditRepository();
    await jobRepo.create(makeJob());
    handler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      undefined,
      auditRepo,
      jobRepo,
    );
  });

  it('attaches the appointment to the EXISTING linked job and audits the revisit', async () => {
    const result = await handler.execute(makeProposal(basePayload), context);
    expect(result.success).toBe(true);

    const appointment = await appointmentRepo.findById(TENANT, result.resultEntityId!);
    expect(appointment).not.toBeNull();
    // The appointment is attached to the linked (existing) job, not the
    // placeholder jobId from the payload — no new job involved.
    expect(appointment!.jobId).toBe(EXISTING_JOB_ID);

    const events = auditRepo.getAll();
    const revisit = events.find((e) => e.eventType === 'appointment.revisit_linked');
    expect(revisit).toBeDefined();
    expect(revisit!.entityId).toBe(result.resultEntityId);
    expect(revisit!.metadata).toMatchObject({
      revisit: true,
      linkedJobId: EXISTING_JOB_ID,
      proposalId: 'prop-revisit-1',
    });
  });

  it('fails when the linked job does not exist in this tenant', async () => {
    const result = await handler.execute(
      makeProposal({ ...basePayload, linkedJobId: '99999999-9999-4999-8999-999999999999' }),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in this tenant/);
    // Nothing was booked.
    expect(await appointmentRepo.findByDateRange(TENANT, new Date(0), new Date('2100-01-01'))).toHaveLength(0);
  });

  it('cross-tenant linkedJobId resolves as not found', async () => {
    // The job exists — but only in ANOTHER tenant.
    await jobRepo.create(makeJob({ id: '88888888-8888-4888-8888-888888888888', tenantId: OTHER_TENANT }));
    const result = await handler.execute(
      makeProposal({ ...basePayload, linkedJobId: '88888888-8888-4888-8888-888888888888' }),
      context,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in this tenant/);
  });

  it('fails closed when linkedJobId is present but no job repo is wired', async () => {
    const noJobRepoHandler = new CreateAppointmentExecutionHandler(
      appointmentRepo,
      undefined,
      undefined,
      auditRepo,
      undefined,
    );
    const result = await noJobRepoHandler.execute(makeProposal(basePayload), context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/job repository/);
  });

  it('non-revisit payloads behave exactly as before (no revisit audit)', async () => {
    const { linkedJobId: _omit, ...plain } = basePayload;
    const result = await handler.execute(makeProposal(plain), context);
    expect(result.success).toBe(true);
    const appointment = await appointmentRepo.findById(TENANT, result.resultEntityId!);
    expect(appointment!.jobId).toBe(PLACEHOLDER_JOB_ID);
    expect(auditRepo.getAll().some((e) => e.eventType === 'appointment.revisit_linked')).toBe(false);
  });
});
