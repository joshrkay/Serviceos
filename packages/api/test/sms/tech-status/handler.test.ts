import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryUserRepository,
  User,
} from '../../../src/users/user';
import {
  InMemoryAppointmentRepository,
  Appointment,
} from '../../../src/appointments/appointment';
import {
  InMemoryAssignmentRepository,
  AppointmentAssignment,
} from '../../../src/appointments/assignment';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryUnavailableBlockRepository } from '../../../src/availability/unavailable-block';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { MockLLMProvider } from '../../../src/ai/providers/mock';
import { Job, JobRepository } from '../../../src/jobs/job';
import { Customer, CustomerRepository } from '../../../src/customers/customer';
import { approveProposalsBatch } from '../../../src/proposals/actions';
import { InboundSmsContext } from '../../../src/sms/inbound-dispatch';
import {
  handleTechStatusSms,
  tenantLocalDate,
  TechStatusHandlerDeps,
} from '../../../src/sms/tech-status/handler';
import { InMemoryTechStatusTodayRepository } from '../../../src/sms/tech-status/idempotency';

const TENANT = '11111111-1111-1111-1111-111111111111';
const TECH_ID = '22222222-2222-2222-2222-222222222222';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';
const TECH_MOBILE = '+15551230001';
const OWNER_MOBILE = '+15551230002';

function makeAppointment(id: string, start: string, end: string): Appointment {
  return {
    id,
    tenantId: TENANT,
    jobId: 'job-1',
    scheduledStart: new Date(start),
    scheduledEnd: new Date(end),
    timezone: 'America/New_York',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeJobRepo(): JobRepository {
  const job = { id: 'job-1', tenantId: TENANT, customerId: 'cust-1' } as unknown as Job;
  return {
    findById: async (t: string, id: string) => (t === TENANT && id === job.id ? job : null),
  } as unknown as JobRepository;
}

function fakeCustomerRepo(): CustomerRepository {
  const cust = {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Jamie',
    lastName: 'Rivera',
  } as unknown as Customer;
  return {
    findById: async (t: string, id: string) => (t === TENANT && id === cust.id ? cust : null),
  } as unknown as CustomerRepository;
}

interface Harness {
  deps: TechStatusHandlerDeps;
  proposalRepo: InMemoryProposalRepository;
  unavailableRepo: InMemoryUnavailableBlockRepository;
  todayRepo: InMemoryTechStatusTodayRepository;
  auditRepo: InMemoryAuditRepository;
  provider: MockLLMProvider;
}

async function buildHarness(now: Date): Promise<Harness> {
  const userRepo = new InMemoryUserRepository();
  const tech: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: TECH_ID,
    tenantId: TENANT,
    email: 'tech@example.com',
    role: 'technician',
    canFieldServe: false,
    mobileNumber: TECH_MOBILE,
  };
  const owner: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: OWNER_ID,
    tenantId: TENANT,
    email: 'owner@example.com',
    role: 'owner',
    canFieldServe: true,
    mobileNumber: OWNER_MOBILE,
  };
  await userRepo.create(tech);
  await userRepo.create(owner);

  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: 'settings-1',
    tenantId: TENANT,
    businessName: 'Test Co',
    timezone: 'America/New_York',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const appointmentRepo = new InMemoryAppointmentRepository();
  const assignmentRepo = new InMemoryAssignmentRepository();
  // Three remaining appointments today so APPROVE ALL has 3 to batch.
  for (const [id, s, e] of [
    [crypto.randomUUID(), '2026-05-21T16:00:00Z', '2026-05-21T17:00:00Z'],
    [crypto.randomUUID(), '2026-05-21T18:00:00Z', '2026-05-21T19:00:00Z'],
    [crypto.randomUUID(), '2026-05-21T20:00:00Z', '2026-05-21T21:00:00Z'],
  ] as const) {
    await appointmentRepo.create(makeAppointment(id, s, e));
    const assignment: AppointmentAssignment = {
      id: crypto.randomUUID(),
      tenantId: TENANT,
      appointmentId: id,
      technicianId: TECH_ID,
      isPrimary: true,
      assignedBy: 'system',
      assignedAt: new Date(),
    };
    await assignmentRepo.create(assignment);
  }

  const proposalRepo = new InMemoryProposalRepository();
  const unavailableRepo = new InMemoryUnavailableBlockRepository();
  const todayRepo = new InMemoryTechStatusTodayRepository();
  const auditRepo = new InMemoryAuditRepository();
  const mock = createMockLLMGateway();
  const provider = mock.provider;
  provider.setDefaultResponse('Sorry, we need to reschedule. Reply to choose a new time.');

  const deps: TechStatusHandlerDeps = {
    userRepo,
    settingsRepo,
    unavailableBlockRepo: unavailableRepo,
    techStatusTodayRepo: todayRepo,
    auditRepo,
    now: () => now,
    rescheduleDeps: {
      appointmentRepo,
      assignmentRepo,
      proposalRepo,
      jobRepo: fakeJobRepo(),
      customerRepo: fakeCustomerRepo(),
      brandVoiceDeps: { gateway: mock.gateway, settingsRepo },
    },
  };
  return { deps, proposalRepo, unavailableRepo, todayRepo, auditRepo, provider };
}

function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: TECH_MOBILE,
    body: 'OUT',
    messageSid: 'SM' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

describe('P6-028 tech_out — tech-status SMS handler', () => {
  const NOW = new Date('2026-05-21T15:00:00Z'); // 11:00 ET, before all appts

  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness(NOW);
  });

  it('tech replies OUT → status recorded, block written, reschedule proposals fire', async () => {
    const result = await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);
    expect(result.handled).toBe(true);
    expect(result.reason).toBe('recorded');

    const blocks = await h.unavailableRepo.findByTechnician(TENANT, TECH_ID);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].reason).toBe('out');

    const proposals = await h.proposalRepo.findByStatus(TENANT, 'ready_for_review');
    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => typeof p.sourceContext?.draftSms === 'string')).toBe(true);
  });

  it('wrong-number inbound (owner mobile, not a technician) is rejected', async () => {
    const result = await handleTechStatusSms(
      ctx({ fromE164: OWNER_MOBILE, body: 'OUT' }),
      h.deps,
    );
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown_mobile');

    // No side effects.
    expect(await h.unavailableRepo.findByTechnician(TENANT, TECH_ID)).toHaveLength(0);
    expect(await h.proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(0);
    const audits = await h.auditRepo.findByEntity(TENANT, 'tech_status', OWNER_ID);
    expect(audits.some((a) => a.eventType === 'tech_status.unverified_mobile')).toBe(true);
  });

  it('unknown mobile is rejected truthfully (handled:false, reason unknown_mobile)', async () => {
    const result = await handleTechStatusSms(
      ctx({ fromE164: '+15559999999', body: 'SICK' }),
      h.deps,
    );
    expect(result).toMatchObject({ handled: false, reason: 'unknown_mobile' });
  });

  it('idempotent — second OUT same local day is a no-op', async () => {
    await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);
    const second = await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);

    expect(second.handled).toBe(true);
    expect(second.reason).toBe('already_recorded');
    // Still exactly one block + the first batch of proposals (no duplicates).
    expect(await h.unavailableRepo.findByTechnician(TENANT, TECH_ID)).toHaveLength(1);
    expect(await h.proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(3);
  });

  it('processing failure releases the claim so a retry re-attempts (no permanent strand)', async () => {
    // First block write fails after the day is already claimed.
    const realCreate = h.unavailableRepo.create.bind(h.unavailableRepo);
    let calls = 0;
    h.unavailableRepo.create = async (block) => {
      calls += 1;
      if (calls === 1) throw new Error('db write failed');
      return realCreate(block);
    };

    const failed = await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);
    expect(failed).toMatchObject({ handled: false, reason: 'processing_failed' });

    // The claim was released — the day is NOT falsely marked handled.
    const local = tenantLocalDate(NOW, 'America/New_York');
    expect(await h.todayRepo.findToday(TENANT, TECH_ID, local)).toBeNull();
    const audits = await h.auditRepo.findByEntity(TENANT, 'tech_status', TECH_ID);
    expect(audits.some((a) => a.eventType === 'tech_status.processing_failed')).toBe(true);

    // Retry now succeeds end-to-end (claim available again, block + proposals land).
    const ok = await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);
    expect(ok).toMatchObject({ handled: true, reason: 'recorded' });
    expect(await h.unavailableRepo.findByTechnician(TENANT, TECH_ID)).toHaveLength(1);
    expect(await h.proposalRepo.findByStatus(TENANT, 'ready_for_review')).toHaveLength(3);
  });

  it('status auto-clears at midnight tenant-local (new day → not a no-op)', async () => {
    await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);

    // Next day, same tech. New local_date ⇒ no row ⇒ idempotency passes again.
    const nextDay = await buildHarness(new Date('2026-05-22T15:00:00Z'));
    // Reuse the SAME idempotency repo to prove the PK (with local_date) is what
    // gates it — carry over the first day's claim.
    await nextDay.deps.techStatusTodayRepo.claimToday({
      tenantId: TENANT,
      technicianId: TECH_ID,
      localDate: tenantLocalDate(NOW, 'America/New_York'),
      status: 'out',
      sourceMessageSid: 'seed',
    });
    const result = await handleTechStatusSms(ctx({ body: 'OUT' }), nextDay.deps);
    expect(result.handled).toBe(true);
    expect(result.reason).toBe('recorded');
  });

  it('owner APPROVE ALL applies to all pending tech-status reschedules', async () => {
    await handleTechStatusSms(ctx({ body: 'OUT' }), h.deps);
    const pending = await h.proposalRepo.findByStatus(TENANT, 'ready_for_review');
    expect(pending.length).toBe(3);

    const batch = await approveProposalsBatch(
      h.proposalRepo,
      TENANT,
      pending.map((p) => p.id),
      OWNER_ID,
      'owner',
    );
    expect(batch.approved).toHaveLength(3);
    expect(batch.failed).toHaveLength(0);
    expect(await h.proposalRepo.findByStatus(TENANT, 'approved')).toHaveLength(3);
  });

  it('tenantLocalDate computes the tenant-local calendar date, not server-local', () => {
    // 04:00 UTC on May 22 is still May 22 in UTC but May 22 00:00 ET.
    // 03:00 UTC is May 21 23:00 ET → previous local day.
    expect(tenantLocalDate(new Date('2026-05-22T03:00:00Z'), 'America/New_York')).toBe('2026-05-21');
    expect(tenantLocalDate(new Date('2026-05-22T05:00:00Z'), 'America/New_York')).toBe('2026-05-22');
  });
});
