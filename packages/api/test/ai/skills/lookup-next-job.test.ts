/**
 * #1604 — `lookupNextJob` skill: "read me the next job".
 *
 * The one lookup that returns an ADDRESS and NOTES (the 2026-10-04
 * assessment's gap #6: nothing for the truck). Same scope contract as
 * `lookup-my-day.ts`: the caller resolves WHOSE schedule (an already-resolved
 * `technicianId`, or `wholeTenant` for a dispatch-grade actor) BEFORE this
 * runs; the skill never guesses and never widens past the one technician.
 *
 * Seam: the exported skill function over in-memory repositories. Expected
 * sentences are the issue's spoken order (time → customer → address → access
 * notes → latest note), written here as literals — never recomputed the way
 * the skill composes them.
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupNextJob } from '../../../src/ai/skills/lookup-next-job';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../../src/appointments/appointment';
import { InMemoryJobRepository, type Job } from '../../../src/jobs/job';
import { InMemoryCustomerRepository, type Customer } from '../../../src/customers/customer';
import { InMemoryLocationRepository, type ServiceLocation } from '../../../src/locations/location';
import { InMemoryNoteRepository, type InternalNote } from '../../../src/notes/note';
import { InMemoryUserRepository } from '../../../src/users/user';
import type { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

const TENANT = 'tenant-1604';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York (11:00 UTC) — a Thursday.
const NOW = new Date('2026-06-11T11:00:00.000Z');
const ME = 'tech-mike';
const COWORKER = 'tech-carlos';

const SEEDED = new Date('2026-06-01T00:00:00.000Z');

function makeCustomer(over: Partial<Customer>): Customer {
  return {
    id: 'cust-keller',
    tenantId: TENANT,
    firstName: 'Dana',
    lastName: 'Keller',
    displayName: 'Dana Keller',
    primaryPhone: '+15125550199',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'u1',
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  } as Customer;
}

function makeLocation(over: Partial<ServiceLocation>): ServiceLocation {
  return {
    id: 'loc-keller',
    tenantId: TENANT,
    customerId: 'cust-keller',
    street1: '4120 East Oakhurst Boulevard',
    city: 'Yonkers',
    state: 'NY',
    postalCode: '10701',
    country: 'US',
    accessNotes: 'Gate code 4421, dog in the yard',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  };
}

function makeJob(over: Partial<Job>): Job {
  return {
    id: 'job-keller',
    tenantId: TENANT,
    customerId: 'cust-keller',
    locationId: 'loc-keller',
    jobNumber: 'JOB-0001',
    summary: 'Water heater replacement',
    status: 'scheduled',
    priority: 'normal',
    assignedTechnicianId: ME,
    createdBy: 'u1',
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  } as Job;
}

function makeAppointment(over: Partial<Appointment>): Appointment {
  return {
    id: 'appt-keller',
    tenantId: TENANT,
    jobId: 'job-keller',
    scheduledStart: new Date('2026-06-11T18:00:00.000Z'), // 2 PM NY, today
    scheduledEnd: new Date('2026-06-11T20:00:00.000Z'),
    timezone: TZ,
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u1',
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  };
}

function makeNote(over: Partial<InternalNote>): InternalNote {
  return {
    id: `note-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    entityType: 'job',
    entityId: 'job-keller',
    content: 'Parts ordered.',
    authorId: 'u1',
    authorRole: 'owner',
    isPinned: false,
    createdAt: SEEDED,
    updatedAt: SEEDED,
    ...over,
  };
}

function eventsSpy(): LookupEventService {
  return { record: vi.fn(async () => ({}) as never) } as unknown as LookupEventService;
}

interface FixtureOpts {
  customers?: Customer[];
  locations?: ServiceLocation[];
  jobs?: Job[];
  appointments?: Appointment[];
  notes?: InternalNote[];
}

async function fixtures(opts: FixtureOpts = {}) {
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const noteRepo = new InMemoryNoteRepository();
  const userRepo = new InMemoryUserRepository();
  for (const c of opts.customers ?? [makeCustomer({})]) await customerRepo.create(c);
  for (const l of opts.locations ?? [makeLocation({})]) await locationRepo.create(l);
  for (const j of opts.jobs ?? []) await jobRepo.create(j);
  for (const a of opts.appointments ?? []) await appointmentRepo.create(a);
  for (const n of opts.notes ?? []) await noteRepo.create(n);
  await userRepo.create({
    id: ME,
    tenantId: TENANT,
    email: 'mike@example.com',
    role: 'technician',
    firstName: 'Mike',
    lastName: 'Diaz',
    canFieldServe: true,
  });
  await userRepo.create({
    id: COWORKER,
    tenantId: TENANT,
    email: 'carlos@example.com',
    role: 'technician',
    firstName: 'Carlos',
    lastName: 'Ruiz',
    canFieldServe: true,
  });
  return { appointmentRepo, jobRepo, customerRepo, locationRepo, noteRepo, userRepo };
}

/** A second household, assigned to the coworker, visited BEFORE Mike's 2 PM. */
const PATEL = {
  customer: makeCustomer({
    id: 'cust-patel',
    firstName: 'Priya',
    lastName: 'Patel',
    displayName: 'Priya Patel',
    primaryPhone: '+15125550288',
  }),
  location: makeLocation({
    id: 'loc-patel',
    customerId: 'cust-patel',
    street1: '88 Mill Lane',
    city: 'Tarrytown',
    postalCode: '10591',
    accessNotes: undefined,
  }),
  job: makeJob({
    id: 'job-patel',
    customerId: 'cust-patel',
    locationId: 'loc-patel',
    jobNumber: 'JOB-0002',
    summary: 'AC tune-up',
    assignedTechnicianId: COWORKER,
  }),
  appointment: makeAppointment({
    id: 'appt-patel',
    jobId: 'job-patel',
    scheduledStart: new Date('2026-06-11T13:00:00.000Z'), // 9 AM NY, today
    scheduledEnd: new Date('2026-06-11T14:00:00.000Z'),
  }),
};

describe('lookupNextJob skill', () => {
  it("reads the technician's next visit today in spoken order: time, customer, job, address, access notes, latest note", async () => {
    const deps = await fixtures({
      jobs: [makeJob({})],
      appointments: [makeAppointment({})],
      notes: [
        makeNote({ id: 'note-old', content: 'Parts ordered.', createdAt: new Date('2026-06-01T12:00:00.000Z') }),
        makeNote({
          id: 'note-new',
          content: 'Customer prefers a text before arrival.',
          createdAt: new Date('2026-06-10T12:00:00.000Z'),
        }),
      ],
    });
    const events = eventsSpy();

    const res = await lookupNextJob(
      { tenantId: TENANT, sessionId: 'sess-1', technicianId: ME, timezone: TZ, now: NOW },
      { ...deps, lookupEvents: events },
    );

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.summary).toBe(
      'Your next job is today at 2 PM — Dana Keller, Water heater replacement, at 4120 East Oakhurst Boulevard, Yonkers. ' +
        'Access notes: Gate code 4421, dog in the yard. Latest note: Customer prefers a text before arrival.',
    );
    expect(res.data.appointmentId).toBe('appt-keller');
    expect(res.data.jobId).toBe('job-keller');
    // The phone never leaves the skill unmasked (the lookup_customer rule).
    expect(res.data.customerPhoneMasked).toBe('+1***0199');
    expect(JSON.stringify(res)).not.toContain('5125550199');
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        sessionId: 'sess-1',
        intent: 'lookup_next_job',
        resultStatus: 'found',
        resultCount: 1,
      }),
    );
  });

  it("owner (whole tenant) hears the BUSINESS's earliest upcoming visit, naming the technician", async () => {
    const deps = await fixtures({
      customers: [makeCustomer({}), PATEL.customer],
      locations: [makeLocation({}), PATEL.location],
      jobs: [makeJob({}), PATEL.job],
      appointments: [makeAppointment({}), PATEL.appointment],
    });

    const res = await lookupNextJob({ tenantId: TENANT, wholeTenant: true, timezone: TZ, now: NOW }, deps);

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.appointmentId).toBe('appt-patel');
    expect(res.summary).toBe(
      'The next job is today at 9 AM — Priya Patel, AC tune-up, at 88 Mill Lane, Tarrytown, with Carlos Ruiz.',
    );
  });

  it("a technician whose only upcoming visit is a COWORKER's hears nothing coming up — never widens to the coworker's job", async () => {
    const deps = await fixtures({
      customers: [PATEL.customer],
      locations: [PATEL.location],
      jobs: [PATEL.job],
      appointments: [PATEL.appointment],
    });
    const events = eventsSpy();

    const res = await lookupNextJob(
      { tenantId: TENANT, sessionId: 'sess-2', technicianId: ME, timezone: TZ, now: NOW },
      { ...deps, lookupEvents: events },
    );

    expect(res.status).toBe('none');
    expect(res.summary).toBe('Nothing is coming up on the schedule in the next two weeks.');
    expect(JSON.stringify(res)).not.toContain('Priya');
    expect(JSON.stringify(res)).not.toContain('Mill Lane');
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'lookup_next_job', resultStatus: 'none', resultCount: 0 }),
    );
  });

  it("a technician NAMING a coworker's job is refused honestly — the job is never read out", async () => {
    const deps = await fixtures({
      customers: [makeCustomer({}), PATEL.customer],
      locations: [makeLocation({}), PATEL.location],
      jobs: [makeJob({}), PATEL.job],
      appointments: [makeAppointment({}), PATEL.appointment],
    });

    const res = await lookupNextJob(
      { tenantId: TENANT, technicianId: ME, jobId: 'job-patel', timezone: TZ, now: NOW },
      deps,
    );

    expect(res.status).toBe('none');
    expect(res.summary).toBe("That job isn't on your schedule, so I can't read it out.");
    expect(JSON.stringify(res)).not.toContain('Priya');
    expect(JSON.stringify(res)).not.toContain('Mill Lane');
  });

  it('a technician naming their OWN job whose only visit is completed hears that it has no upcoming visit', async () => {
    const deps = await fixtures({
      jobs: [makeJob({}), PATEL.job],
      appointments: [makeAppointment({ status: 'completed' }), PATEL.appointment],
    });

    const res = await lookupNextJob(
      { tenantId: TENANT, technicianId: ME, jobId: 'job-keller', timezone: TZ, now: NOW },
      deps,
    );

    expect(res.status).toBe('none');
    expect(res.summary).toBe('That job has no upcoming visit on the schedule.');
  });

  it('a repository failure degrades to an honest error result (never a throw into the dispatch), and is recorded', async () => {
    const deps = await fixtures({ jobs: [makeJob({})], appointments: [makeAppointment({})] });
    const events = eventsSpy();
    const broken = {
      ...deps,
      appointmentRepo: {
        findByDateRange: async () => {
          throw new Error('connection reset');
        },
      },
      lookupEvents: events,
    };

    const res = await lookupNextJob({ tenantId: TENANT, technicianId: ME, timezone: TZ, now: NOW }, broken);

    expect(res.status).toBe('error');
    expect(res.summary).toBe("I'm having trouble pulling up your next job right now.");
    if (res.status !== 'error') throw new Error('unreachable');
    expect(res.data.error).toBe('connection reset');
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'lookup_next_job', resultStatus: 'error', resultCount: 0 }),
    );
  });
});
