import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmergencyDispatchExecutionHandler } from '../../src/proposals/execution/emergency-dispatch-handler';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { findBookableSlots } from '../../src/scheduling/booking-availability';
import type { Proposal } from '../../src/proposals/proposal';
import type { SettingsRepository } from '../../src/settings/settings';

// The soonest-feasible-slot search is mocked so each branch (slot found / no
// slot / finder failure) is deterministic. The hold WRITE still runs against a
// real InMemoryAppointmentRepository, and the end-to-end Pg path (real finder +
// real columns) is pinned by test/integration/emergency-dispatch-hold.test.ts.
vi.mock('../../src/scheduling/booking-availability', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/scheduling/booking-availability')>();
  return { ...actual, findBookableSlots: vi.fn() };
});
const mockedFind = vi.mocked(findBookableSlots);

const TENANT = 't1';
const CUSTOMER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ctx = { tenantId: TENANT, executedBy: 'owner-1' };

function makeProposal(payload: Record<string, unknown>, id = 'prop-em-hold-1'): Proposal {
  const now = new Date();
  return {
    id,
    tenantId: TENANT,
    proposalType: 'emergency_dispatch',
    status: 'approved',
    payload,
    summary: 'Emergency dispatch',
    createdBy: 'calling-agent',
    createdAt: now,
    updatedAt: now,
  };
}

function settingsStub(overrides: Record<string, unknown> = {}): SettingsRepository {
  return {
    findByTenant: vi.fn(async () => ({
      ownerPhone: '+15125550999',
      businessName: 'Acme Plumbing',
      timezone: 'America/Chicago',
      ...overrides,
    })),
  } as unknown as SettingsRepository;
}

async function seedLocation(locationRepo: InMemoryLocationRepository) {
  await locationRepo.create({
    id: 'loc-1',
    tenantId: TENANT,
    customerId: CUSTOMER,
    street1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
    isPrimary: true,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function futureSlot() {
  const start = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

function executedAudit(auditRepo: InMemoryAuditRepository) {
  return auditRepo.getAll().find((e) => e.eventType === 'emergency_dispatch.executed');
}

describe('RV-141 hold — EmergencyDispatchExecutionHandler appointment hold', () => {
  beforeEach(() => {
    mockedFind.mockReset();
  });

  it('places a tentative hold on the soonest slot and names it in the owner page', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    await seedLocation(locationRepo);
    const appointmentRepo = new InMemoryAppointmentRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    const { start, end } = futureSlot();
    mockedFind.mockResolvedValue([{ start, end }]);

    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
      appointmentRepo,
      undefined,
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: {
          emergencyDescription: 'gas leak in the basement',
          detectedKeywords: ['gas leak'],
          customerId: CUSTOMER,
        },
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    const jobs = await jobRepo.findByTenant(TENANT);
    expect(jobs).toHaveLength(1);

    const appts = await appointmentRepo.findByJob(TENANT, jobs[0].id);
    expect(appts).toHaveLength(1);
    expect(appts[0].holdPendingApproval).toBe(true);
    expect(appts[0].holdExpiryAt).toBeInstanceOf(Date);
    expect(appts[0].holdExpiryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(appts[0].scheduledStart.getTime()).toBe(start.getTime());
    expect(appts[0].jobId).toBe(jobs[0].id);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0].body).toContain('Held');
    expect(sendSms.mock.calls[0][0].body).toContain('pending your confirmation');

    expect(executedAudit(auditRepo)?.metadata?.appointmentHoldId).toBe(appts[0].id);
  });

  it('no feasible slot: no hold, but job + page still succeed', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    await seedLocation(locationRepo);
    const appointmentRepo = new InMemoryAppointmentRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    mockedFind.mockResolvedValue([]);

    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
      appointmentRepo,
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: { emergencyDescription: 'flooding', detectedKeywords: ['flooding'], customerId: CUSTOMER },
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    const jobs = await jobRepo.findByTenant(TENANT);
    expect(jobs).toHaveLength(1);
    expect(await appointmentRepo.findByJob(TENANT, jobs[0].id)).toHaveLength(0);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0].body).not.toContain('Held');
    expect(executedAudit(auditRepo)?.metadata?.holdSkipReason).toBe('no_feasible_slot');
  });

  it('finder failure is swallowed: the dispatch still succeeds without a hold', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    await seedLocation(locationRepo);
    const appointmentRepo = new InMemoryAppointmentRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));
    mockedFind.mockRejectedValue(new Error('availability down'));

    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
      appointmentRepo,
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: { emergencyDescription: 'sparking outlet', customerId: CUSTOMER },
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    const jobs = await jobRepo.findByTenant(TENANT);
    expect(await appointmentRepo.findByJob(TENANT, jobs[0].id)).toHaveLength(0);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(executedAudit(auditRepo)?.metadata?.holdSkipReason).toContain('availability down');
  });

  it('anonymous caller: no job, no hold, finder is never called, page still goes out', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));

    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
      appointmentRepo,
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: { emergencyDescription: 'carbon monoxide alarm' },
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(await jobRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(mockedFind).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0].body).toContain('No customer match');
    expect(executedAudit(auditRepo)?.metadata?.holdSkipReason).toBe('no_job_to_hold');
  });

  it('no appointmentRepo wired: hold skipped, job + page unchanged', async () => {
    const jobRepo = new InMemoryJobRepository();
    const locationRepo = new InMemoryLocationRepository();
    await seedLocation(locationRepo);
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async (_args: { to: string; body: string }) => ({}));

    const handler = new EmergencyDispatchExecutionHandler(
      jobRepo,
      locationRepo,
      settingsStub(),
      { sendSms },
      auditRepo,
    );

    const result = await handler.execute(
      makeProposal({
        intent: 'emergency_dispatch',
        entities: { emergencyDescription: 'burst pipe', customerId: CUSTOMER },
      }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(mockedFind).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0][0].body).not.toContain('Held');
    expect(executedAudit(auditRepo)?.metadata?.holdSkipReason).toBe('appointment_repo_not_wired');
  });
});
