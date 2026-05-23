import { describe, it, expect, beforeEach } from 'vitest';
import {
  Appointment,
  AppointmentRepository,
  InMemoryAppointmentRepository,
} from '../../../src/appointments/appointment';
import {
  AppointmentAssignment,
  AssignmentRepository,
  InMemoryAssignmentRepository,
} from '../../../src/appointments/assignment';
import {
  InMemoryProposalRepository,
  ProposalRepository,
} from '../../../src/proposals/proposal';
import { Job, JobRepository } from '../../../src/jobs/job';
import { Customer, CustomerRepository } from '../../../src/customers/customer';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { MockLLMProvider } from '../../../src/ai/providers/mock';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import type { ComposeBrandVoiceDeps } from '../../../src/ai/brand-voice/composer';
import {
  createRescheduleProposalsFromTechOut,
  findRemainingAppointmentsToday,
} from '../../../src/scheduling/reschedule/from-tech-out';
import { draftCustomerRescheduleMessage } from '../../../src/scheduling/reschedule/customer-message-draft';

const TENANT = '11111111-1111-1111-1111-111111111111';
const TECH = '22222222-2222-2222-2222-222222222222';

function makeAppointment(overrides: Partial<Appointment>): Appointment {
  const now = new Date('2026-05-21T15:00:00Z');
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tenantId: TENANT,
    jobId: overrides.jobId ?? 'job-1',
    scheduledStart: overrides.scheduledStart ?? new Date('2026-05-21T16:00:00Z'),
    scheduledEnd: overrides.scheduledEnd ?? new Date('2026-05-21T17:00:00Z'),
    timezone: 'America/New_York',
    status: overrides.status ?? 'scheduled',
    holdPendingApproval: false,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeJobRepo(jobs: Job[]): JobRepository {
  return {
    findById: async (tenantId: string, id: string) =>
      jobs.find((j) => j.tenantId === tenantId && j.id === id) ?? null,
  } as unknown as JobRepository;
}

function fakeCustomerRepo(customers: Customer[]): CustomerRepository {
  return {
    findById: async (tenantId: string, id: string) =>
      customers.find((c) => c.tenantId === tenantId && c.id === id) ?? null,
  } as unknown as CustomerRepository;
}

describe('P6-028 reschedule_from_tech — from-tech-out proposal walk', () => {
  let appointmentRepo: AppointmentRepository;
  let assignmentRepo: AssignmentRepository;
  let proposalRepo: ProposalRepository;
  let provider: MockLLMProvider;
  let brandVoiceDeps: ComposeBrandVoiceDeps;

  const job: Job = {
    id: 'job-1',
    tenantId: TENANT,
    customerId: 'cust-1',
  } as unknown as Job;
  const customer: Customer = {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Jamie',
    lastName: 'Rivera',
  } as unknown as Customer;

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    proposalRepo = new InMemoryProposalRepository();
    const mock = createMockLLMGateway();
    provider = mock.provider;
    provider.setDefaultResponse('Sorry, we need to reschedule your visit. Reply to pick a new time.');
    const settingsRepo = new InMemorySettingsRepository();
    brandVoiceDeps = { gateway: mock.gateway, settingsRepo };
  });

  async function assign(appt: Appointment): Promise<void> {
    await appointmentRepo.create(appt);
    const assignment: AppointmentAssignment = {
      id: crypto.randomUUID(),
      tenantId: TENANT,
      appointmentId: appt.id,
      technicianId: TECH,
      isPrimary: true,
      assignedBy: 'system',
      assignedAt: new Date(),
    };
    await assignmentRepo.create(assignment);
  }

  it('finds only same-day, non-terminal remaining appointments', async () => {
    const windowStart = new Date('2026-05-21T15:00:00Z');
    const windowEnd = new Date('2026-05-22T04:00:00Z');

    const upcoming = makeAppointment({ id: crypto.randomUUID() });
    const past = makeAppointment({
      id: crypto.randomUUID(),
      scheduledStart: new Date('2026-05-21T10:00:00Z'),
      scheduledEnd: new Date('2026-05-21T11:00:00Z'),
    });
    const completed = makeAppointment({ id: crypto.randomUUID(), status: 'completed' });
    const canceled = makeAppointment({ id: crypto.randomUUID(), status: 'canceled' });
    await assign(upcoming);
    await assign(past);
    await assign(completed);
    await assign(canceled);

    const found = await findRemainingAppointmentsToday(
      { appointmentRepo, assignmentRepo },
      TENANT,
      TECH,
      windowStart,
      windowEnd,
    );
    expect(found.map((a) => a.id)).toEqual([upcoming.id]);
  });

  it('tech_out — creates one reschedule proposal per remaining appointment with brand-voice draftSms', async () => {
    const windowStart = new Date('2026-05-21T15:00:00Z');
    const windowEnd = new Date('2026-05-22T04:00:00Z');
    await assign(makeAppointment({ id: crypto.randomUUID(), scheduledStart: new Date('2026-05-21T16:00:00Z'), scheduledEnd: new Date('2026-05-21T17:00:00Z') }));
    await assign(makeAppointment({ id: crypto.randomUUID(), scheduledStart: new Date('2026-05-21T18:00:00Z'), scheduledEnd: new Date('2026-05-21T19:00:00Z') }));

    const { proposals } = await createRescheduleProposalsFromTechOut(
      {
        tenantId: TENANT,
        technicianId: TECH,
        windowStart,
        windowEnd,
        createdBy: TECH,
        reason: 'out',
      },
      {
        appointmentRepo,
        assignmentRepo,
        proposalRepo,
        jobRepo: fakeJobRepo([job]),
        customerRepo: fakeCustomerRepo([customer]),
        brandVoiceDeps,
      },
    );

    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.proposalType).toBe('reschedule_appointment');
      // never auto-execute — owner approves from the review queue
      expect(p.status).toBe('ready_for_review');
      expect(typeof p.sourceContext?.draftSms).toBe('string');
      expect((p.sourceContext?.draftSms as string).length).toBeGreaterThan(0);
      expect(p.payload.appointmentId).toBeTruthy();
      expect(p.targetEntityType).toBe('appointment');
    }
    // The draft references the customer name (brand voice composes from context).
    expect(proposals[0].summary).toContain('Jamie Rivera');

    // Persisted to the proposal repo in the review queue so APPROVE ALL can
    // pick them up.
    const pending = await proposalRepo.findByStatus(TENANT, 'ready_for_review');
    expect(pending).toHaveLength(2);
  });

  it('customer SMS draft is enforced to <= maxChars (brand voice)', async () => {
    provider.setDefaultResponse('x'.repeat(500));
    const draft = await draftCustomerRescheduleMessage(
      { tenantId: TENANT, customerName: 'Jamie', appointmentTime: '4pm', maxChars: 160 },
      brandVoiceDeps,
    );
    expect(draft.text.length).toBeLessThanOrEqual(160);
    expect(draft.promptVersionId).toBeTruthy();
  });
});
