/**
 * #1604 — `executeLookupAnswer`'s `lookup_next_job` case: WHOSE next job is
 * decided here, from the asking actor's DB-authoritative role, exactly as
 * `lookup_my_day` does:
 *   - `dispatch:view` (owner, dispatcher) → the business's next visit;
 *   - anyone else → the resolved SPEAKER's own assignments only;
 *   - no / unresolvable actor → the turn FAILS — never an unscoped answer.
 *
 * Seam: the one shared lookup dispatch every surface calls (phone, memo,
 * chat, in-app voice). Expected sentences are literals from the issue's
 * spoken order; the address and the masked phone ride the answer card rows.
 */
import { describe, it, expect } from 'vitest';
import { executeLookupAnswer } from '../../src/workers/voice-lookup-answer';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryLocationRepository, type ServiceLocation } from '../../src/locations/location';
import { InMemoryNoteRepository } from '../../src/notes/note';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';

const TENANT = 'tenant-1604-dispatch';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York (11:00 UTC).
const NOW = new Date('2026-06-11T11:00:00.000Z');
const SEEDED = new Date('2026-06-01T00:00:00.000Z');

const OWNER_CLERK = 'clerk-owner';
const MIKE_CLERK = 'clerk-mike';
const MIKE = 'tech-mike';
const CARLOS = 'tech-carlos';
// Job ids are UUIDs in production — the answer card's entityRef.id is schema-checked as one.
const JOB_KELLER = 'a0000000-0000-4000-8000-000000001604';
const JOB_PATEL = 'a0000000-0000-4000-8000-000000001605';

function customer(over: Partial<Customer>): Customer {
  return {
    tenantId: TENANT,
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'u1',
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  } as Customer;
}

function location(over: Partial<ServiceLocation>): ServiceLocation {
  return {
    tenantId: TENANT,
    state: 'NY',
    country: 'US',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  } as ServiceLocation;
}

function job(over: Partial<Job>): Job {
  return {
    tenantId: TENANT,
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'u1',
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  } as Job;
}

function appointment(over: Partial<Appointment>): Appointment {
  return {
    tenantId: TENANT,
    timezone: TZ,
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u1',
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  } as Appointment;
}

async function world() {
  const userRepo = new InMemoryUserRepository();
  await userRepo.create({
    id: 'owner-id',
    tenantId: TENANT,
    clerkUserId: OWNER_CLERK,
    email: 'owner@example.com',
    role: 'owner',
    firstName: 'Sam',
    lastName: 'Owner',
    canFieldServe: false,
  });
  await userRepo.create({
    id: MIKE,
    tenantId: TENANT,
    clerkUserId: MIKE_CLERK,
    email: 'mike@example.com',
    role: 'technician',
    firstName: 'Mike',
    lastName: 'Diaz',
    canFieldServe: true,
  });
  await userRepo.create({
    id: CARLOS,
    tenantId: TENANT,
    email: 'carlos@example.com',
    role: 'technician',
    firstName: 'Carlos',
    lastName: 'Ruiz',
    canFieldServe: true,
  });

  const customerRepo = new InMemoryCustomerRepository();
  await customerRepo.create(
    customer({ id: 'cust-keller', firstName: 'Dana', lastName: 'Keller', displayName: 'Dana Keller', primaryPhone: '+15125550199' }),
  );
  await customerRepo.create(
    customer({ id: 'cust-patel', firstName: 'Priya', lastName: 'Patel', displayName: 'Priya Patel', primaryPhone: '+15125550288' }),
  );

  const locationRepo = new InMemoryLocationRepository();
  await locationRepo.create(
    location({
      id: 'loc-keller',
      customerId: 'cust-keller',
      street1: '4120 East Oakhurst Boulevard',
      city: 'Yonkers',
      postalCode: '10701',
      accessNotes: 'Gate code 4421, dog in the yard',
    }),
  );
  await locationRepo.create(
    location({ id: 'loc-patel', customerId: 'cust-patel', street1: '88 Mill Lane', city: 'Tarrytown', postalCode: '10591' }),
  );

  const jobRepo = new InMemoryJobRepository();
  await jobRepo.create(
    job({ id: JOB_KELLER, customerId: 'cust-keller', locationId: 'loc-keller', jobNumber: 'JOB-0001', summary: 'Water heater replacement', assignedTechnicianId: MIKE }),
  );
  await jobRepo.create(
    job({ id: JOB_PATEL, customerId: 'cust-patel', locationId: 'loc-patel', jobNumber: 'JOB-0002', summary: 'AC tune-up', assignedTechnicianId: CARLOS }),
  );

  const appointmentRepo = new InMemoryAppointmentRepository();
  // Mike at 2 PM, Carlos at 9 AM — the business's NEXT visit is Carlos's.
  await appointmentRepo.create(
    appointment({ id: 'appt-keller', jobId: JOB_KELLER, scheduledStart: new Date('2026-06-11T18:00:00.000Z'), scheduledEnd: new Date('2026-06-11T20:00:00.000Z') }),
  );
  await appointmentRepo.create(
    appointment({ id: 'appt-patel', jobId: JOB_PATEL, scheduledStart: new Date('2026-06-11T13:00:00.000Z'), scheduledEnd: new Date('2026-06-11T14:00:00.000Z') }),
  );

  const noteRepo = new InMemoryNoteRepository();
  await noteRepo.create({
    id: 'note-keller',
    tenantId: TENANT,
    entityType: 'job',
    entityId: JOB_KELLER,
    content: 'Customer prefers a text before arrival.',
    authorId: 'u1',
    authorRole: 'owner',
    isPinned: false,
    createdAt: SEEDED,
    updatedAt: SEEDED,
  });

  const resolveMemberRole = async (_tenant: string, userId: string): Promise<string | null> =>
    userId === OWNER_CLERK ? 'owner' : userId === MIKE_CLERK ? 'technician' : null;

  return {
    deps: { resolveMemberRole, locationRepo, noteRepo },
    shared: { jobRepo, appointmentRepo, customerRepo, userRepo, proposalRepo: new InMemoryProposalRepository() },
  };
}

const base = { tenantId: TENANT, sessionId: '00000000-0000-4000-8000-000000001604', intent: 'lookup_next_job' as const, timezone: TZ, now: NOW };

describe('executeLookupAnswer — lookup_next_job (#1604)', () => {
  it("an owner (dispatch:view) hears the BUSINESS's next visit with its technician; the card carries the address and a masked phone", async () => {
    const w = await world();

    const execution = await executeLookupAnswer({ ...base, actorId: OWNER_CLERK }, w.deps, w.shared);

    expect(execution.kind).toBe('answer');
    if (execution.kind !== 'answer') throw new Error('unreachable');
    expect(execution.answer.result).toBe('found');
    expect(execution.answer.summary).toBe(
      'The next job is today at 9 AM — Priya Patel, AC tune-up, at 88 Mill Lane, Tarrytown, with Carlos Ruiz.',
    );
    expect(execution.answer.rows).toEqual(
      expect.arrayContaining([
        { kind: 'text', label: 'Address', text: '88 Mill Lane, Tarrytown, NY 10591' },
        { kind: 'text', label: 'Phone', text: '+1***0288' },
      ]),
    );
    expect(JSON.stringify(execution)).not.toContain('5125550288');
  });

  it('a technician actor hears THEIR OWN next visit, never the earlier coworker visit', async () => {
    const w = await world();

    const execution = await executeLookupAnswer({ ...base, actorId: MIKE_CLERK }, w.deps, w.shared);

    expect(execution.kind).toBe('answer');
    if (execution.kind !== 'answer') throw new Error('unreachable');
    expect(execution.answer.summary).toBe(
      'Your next job is today at 2 PM — Dana Keller, Water heater replacement, at 4120 East Oakhurst Boulevard, Yonkers. ' +
        'Access notes: Gate code 4421, dog in the yard. Latest note: Customer prefers a text before arrival.',
    );
    expect(JSON.stringify(execution)).not.toContain('Priya');
  });

  it('no actor fails the turn — it never falls back to an unscoped (whole-crew) answer', async () => {
    const w = await world();

    const execution = await executeLookupAnswer({ ...base }, w.deps, w.shared);

    expect(execution).toEqual({ kind: 'failed', error: 'could not match you to a technician' });
  });

  it('the session language reaches the skill: an es caller hears the Spanish readback', async () => {
    const w = await world();

    const execution = await executeLookupAnswer({ ...base, actorId: MIKE_CLERK, language: 'es' }, w.deps, w.shared);

    expect(execution.kind).toBe('answer');
    if (execution.kind !== 'answer') throw new Error('unreachable');
    expect(execution.answer.summary).toBe(
      'Su próximo trabajo es hoy a las 2 p.m. — Dana Keller, Water heater replacement, en 4120 East Oakhurst Boulevard, Yonkers. ' +
        'Notas de acceso: Gate code 4421, dog in the yard. Última nota: Customer prefers a text before arrival.',
    );
  });
});
