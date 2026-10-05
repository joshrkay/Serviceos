/**
 * #1604 — "read me the next job" on the IN-APP ASSISTANT (chat box and the
 * in-app voice surface both route here). Same rules as the phone: a
 * technician hears only their own next visit; a job they NAME that is not
 * theirs is refused by name. Seam: `dispatchAssistantLookup`, the surface
 * adapter over the one shared dispatch.
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchAssistantLookup, type AssistantLookupDeps } from '../../../src/ai/orchestration/lookup-dispatch';
import type { EntityResolver } from '../../../src/ai/resolution/entity-resolver';
import { InMemoryJobRepository, type Job } from '../../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../../src/appointments/appointment';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryLocationRepository, type ServiceLocation } from '../../../src/locations/location';
import { InMemoryUserRepository } from '../../../src/users/user';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';

const TENANT = 'tenant-1604-inapp';
const TZ = 'America/New_York';
const NOW = new Date('2026-06-11T11:00:00.000Z'); // 07:00 New York
const SEEDED = new Date('2026-06-01T00:00:00.000Z');
const MIKE_CLERK = 'clerk-1604-inapp-mike';
const MIKE = 'tech-1604-inapp-mike';
const CARLOS = 'tech-1604-inapp-carlos';
const JOB_KELLER = 'd0000000-0000-4000-8000-000000001604';
const JOB_PATEL = 'd0000000-0000-4000-8000-000000001605';

async function deps(): Promise<AssistantLookupDeps> {
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({ id: MIKE, tenantId: TENANT, clerkUserId: MIKE_CLERK, email: 'mike@example.com', role: 'technician', firstName: 'Mike', lastName: 'Diaz', canFieldServe: true });
  await userRepo.create({ id: CARLOS, tenantId: TENANT, email: 'carlos@example.com', role: 'technician', firstName: 'Carlos', lastName: 'Ruiz', canFieldServe: true });

  const customerRepo = new InMemoryCustomerRepository();
  const customer = (over: Partial<Customer>): Customer =>
    ({ tenantId: TENANT, preferredChannel: 'phone', smsConsent: false, isArchived: false, createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED, ...over }) as Customer;
  await customerRepo.create(customer({ id: 'cust-keller', firstName: 'Dana', lastName: 'Keller', displayName: 'Dana Keller' }));
  await customerRepo.create(customer({ id: 'cust-patel', firstName: 'Priya', lastName: 'Patel', displayName: 'Priya Patel' }));

  const locationRepo = new InMemoryLocationRepository();
  const location = (over: Partial<ServiceLocation>): ServiceLocation =>
    ({ tenantId: TENANT, state: 'NY', country: 'US', isPrimary: true, addressType: 'service', isArchived: false, createdAt: SEEDED, updatedAt: SEEDED, ...over }) as ServiceLocation;
  await locationRepo.create(location({ id: 'loc-keller', customerId: 'cust-keller', street1: '4120 East Oakhurst Boulevard', city: 'Yonkers', postalCode: '10701' }));
  await locationRepo.create(location({ id: 'loc-patel', customerId: 'cust-patel', street1: '88 Mill Lane', city: 'Tarrytown', postalCode: '10591' }));

  const jobRepo = new InMemoryJobRepository();
  const job = (over: Partial<Job>): Job =>
    ({ tenantId: TENANT, status: 'scheduled', priority: 'normal', createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED, ...over }) as Job;
  await jobRepo.create(job({ id: JOB_KELLER, customerId: 'cust-keller', locationId: 'loc-keller', jobNumber: 'JOB-0001', summary: 'Water heater replacement', assignedTechnicianId: MIKE }));
  await jobRepo.create(job({ id: JOB_PATEL, customerId: 'cust-patel', locationId: 'loc-patel', jobNumber: 'JOB-0002', summary: 'AC tune-up', assignedTechnicianId: CARLOS }));

  const appointmentRepo = new InMemoryAppointmentRepository();
  const appointment = (over: Partial<Appointment>): Appointment =>
    ({ tenantId: TENANT, timezone: TZ, status: 'scheduled', holdPendingApproval: false, createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED, ...over }) as Appointment;
  await appointmentRepo.create(appointment({ id: 'appt-keller', jobId: JOB_KELLER, scheduledStart: new Date('2026-06-11T18:00:00.000Z'), scheduledEnd: new Date('2026-06-11T20:00:00.000Z') }));
  await appointmentRepo.create(appointment({ id: 'appt-patel', jobId: JOB_PATEL, scheduledStart: new Date('2026-06-11T13:00:00.000Z'), scheduledEnd: new Date('2026-06-11T14:00:00.000Z') }));

  const entityResolver = {
    resolve: vi.fn(async (input: { reference: string; kind: string }) => {
      if (input.kind !== 'job') return { kind: 'skipped' };
      if (/patel/i.test(input.reference)) {
        return { kind: 'resolved', candidate: { id: JOB_PATEL, kind: 'job', label: 'AC tune-up', score: 0.95 } };
      }
      return { kind: 'not_found', reference: input.reference };
    }),
  } as unknown as EntityResolver;

  return {
    answers: { resolveMemberRole: async (_t, userId) => (userId === MIKE_CLERK ? 'technician' : null), locationRepo },
    shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo: new InMemoryProposalRepository(), userRepo },
    entityResolver,
    tenantTimezoneResolver: async () => TZ,
    now: () => NOW,
  };
}

describe('dispatchAssistantLookup — lookup_next_job (#1604)', () => {
  it('the signed-in technician hears their own next visit as a data-lookup answer', async () => {
    const reply = await dispatchAssistantLookup(
      { tenantId: TENANT, userId: MIKE_CLERK, intent: 'lookup_next_job', extractedEntities: {}, message: 'read me the next job' },
      await deps(),
    );

    expect(reply?.taskType).toBe('assistant.lookup.lookup_next_job');
    expect(reply?.model).toBe('data-lookup');
    expect(reply?.outcome).toBe('answered');
    expect(reply?.message.content).toBe(
      'Your next job is today at 2 PM — Dana Keller, Water heater replacement, at 4120 East Oakhurst Boulevard, Yonkers.',
    );
  });

  it("a technician naming a coworker's job through the resolver is refused by name", async () => {
    const reply = await dispatchAssistantLookup(
      {
        tenantId: TENANT,
        userId: MIKE_CLERK,
        intent: 'lookup_next_job',
        extractedEntities: { jobReference: 'the Patel job' },
        message: 'read me the Patel job',
      },
      await deps(),
    );

    expect(reply?.message.content).toBe("That job isn't on your schedule, so I can't read it out.");
    expect(JSON.stringify(reply)).not.toContain('Mill Lane');
  });
});
