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
import { InMemoryEstimateRepository, createEstimate } from '../../../src/estimates/estimate';
import { InMemoryInvoiceRepository, createInvoice } from '../../../src/invoices/invoice';

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

  it("the signed-in OWNER hears the business's next visit, with its technician", async () => {
    const d = await deps();
    d.answers.resolveMemberRole = async (_t, userId) => (userId === 'clerk-1604-inapp-owner' ? 'owner' : null);

    const reply = await dispatchAssistantLookup(
      { tenantId: TENANT, userId: 'clerk-1604-inapp-owner', intent: 'lookup_next_job', extractedEntities: {}, message: 'read me the next job' },
      d,
    );

    expect(reply?.outcome).toBe('answered');
    expect(reply?.message.content).toBe(
      'The next job is today at 9 AM — Priya Patel, AC tune-up, at 88 Mill Lane, Tarrytown, with Carlos Ruiz.',
    );
  });

  it('an es in-app voice session hears the Spanish readback', async () => {
    const reply = await dispatchAssistantLookup(
      { tenantId: TENANT, userId: MIKE_CLERK, intent: 'lookup_next_job', extractedEntities: {}, message: 'léeme el próximo trabajo', language: 'es' },
      await deps(),
    );

    expect(reply?.message.content).toBe(
      'Su próximo trabajo es hoy a las 2 p.m. — Dana Keller, Water heater replacement, en 4120 East Oakhurst Boulevard, Yonkers.',
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

describe('dispatchAssistantLookup — the record on screen (page context)', () => {
  it('"what jobs does this customer have?" on Keller\'s page answers for Keller without resolving the words', async () => {
    const d = await deps();
    const reply = await dispatchAssistantLookup(
      {
        tenantId: TENANT,
        userId: MIKE_CLERK,
        intent: 'lookup_jobs',
        extractedEntities: { customerName: 'this customer' },
        message: 'what jobs does this customer have?',
        page: { customerId: 'cust-keller' },
      },
      d,
    );
    expect(reply?.outcome).toBe('answered');
    expect(reply?.resolvedCustomer?.id).toBe('cust-keller');
    expect(reply?.message.content).toMatch(/Keller/);
    expect(d.entityResolver.resolve).not.toHaveBeenCalled();
  });

  it('"what\'s the status of this job?" on JOB-0001 answers from that job by its number', async () => {
    const d = await deps();
    const reply = await dispatchAssistantLookup(
      {
        tenantId: TENANT,
        userId: MIKE_CLERK,
        intent: 'lookup_jobs',
        extractedEntities: { jobReference: 'this job' },
        message: "what's the status of this job?",
        page: { jobId: JOB_KELLER, documentNumber: 'JOB-0001' },
      },
      d,
    );
    expect(reply?.outcome).toBe('answered');
    expect(reply?.message.content).toContain('JOB-0001');
    expect(d.entityResolver.resolve).not.toHaveBeenCalled();
  });

  it('"which estimates are on this job?" lists only that job\'s estimates, not the customer\'s other jobs', async () => {
    const d = await deps();
    const jobRepo = d.shared.jobRepo as InMemoryJobRepository;
    await jobRepo.create({
      id: 'd0000000-0000-4000-8000-000000001606', tenantId: TENANT, customerId: 'cust-keller', locationId: 'loc-keller',
      jobNumber: 'JOB-0003', summary: 'Furnace tune-up', status: 'scheduled', priority: 'normal', createdBy: 'u1',
      createdAt: SEEDED, updatedAt: SEEDED,
    } as Job);
    const estimateRepo = new InMemoryEstimateRepository();
    const estimate = (jobId: string, estimateNumber: string) =>
      createEstimate(
        {
          tenantId: TENANT, jobId, estimateNumber, createdBy: 'u1',
          lineItems: [{ id: 'li', description: 'Work', quantity: 1, unitPriceCents: 1000, totalCents: 1000, sortOrder: 0, taxable: false }],
        },
        estimateRepo,
      );
    await estimate(JOB_KELLER, 'EST-WH');
    await estimate('d0000000-0000-4000-8000-000000001606', 'EST-FURNACE');

    const reply = await dispatchAssistantLookup(
      {
        tenantId: TENANT,
        userId: MIKE_CLERK,
        intent: 'lookup_estimates',
        extractedEntities: {},
        message: 'which estimates are on this job?',
        page: { customerId: 'cust-keller', jobId: JOB_KELLER },
      },
      { ...d, answers: { ...d.answers, estimateRepo, resolveMemberRole: async () => 'owner' } },
    );
    expect(reply?.outcome).toBe('answered');
    expect(reply?.message.content).not.toContain('EST-FURNACE');
    expect(reply?.message.content).toContain('one estimate — EST-WH');
  });

  it('a balance asked on an invoice or job page is that record\'s, not the customer\'s whole balance', async () => {
    const d = await deps();
    const jobRepo = d.shared.jobRepo as InMemoryJobRepository;
    const FURNACE = 'd0000000-0000-4000-8000-000000001607';
    await jobRepo.create({
      id: FURNACE, tenantId: TENANT, customerId: 'cust-keller', locationId: 'loc-keller',
      jobNumber: 'JOB-0003', summary: 'Furnace tune-up', status: 'scheduled', priority: 'normal', createdBy: 'u1',
      createdAt: SEEDED, updatedAt: SEEDED,
    } as Job);
    const invoiceRepo = new InMemoryInvoiceRepository();
    const openInvoice = async (jobId: string, invoiceNumber: string, cents: number) => {
      const inv = await createInvoice(
        {
          tenantId: TENANT, jobId, invoiceNumber, createdBy: 'u1',
          lineItems: [{ id: 'li', description: 'Work', quantity: 1, unitPriceCents: cents, totalCents: cents, sortOrder: 0, taxable: false }],
        },
        invoiceRepo,
      );
      await invoiceRepo.update(TENANT, inv.id, { status: 'open', amountDueCents: cents });
    };
    await openInvoice(JOB_KELLER, 'INV-0101', 40000);
    await openInvoice(FURNACE, 'INV-0102', 9000);
    const ask = (message: string, page: { customerId: string; jobId: string; documentNumber?: string }) =>
      dispatchAssistantLookup(
        { tenantId: TENANT, userId: MIKE_CLERK, intent: 'lookup_balance', extractedEntities: {}, message, page },
        { ...d, answers: { ...d.answers, invoiceRepo, resolveMemberRole: async () => 'owner' } },
      );

    const onInvoice = await ask('what does this invoice owe me?', {
      customerId: 'cust-keller', jobId: JOB_KELLER, documentNumber: 'INV-0101',
    });
    expect(onInvoice?.message.content).toContain('INV-0101 is open with $400.00 due.');
    expect(onInvoice?.message.content).not.toContain('490');

    // The balance answer links its customer by uuid, so this half uses one.
    const OWNER = 'c0000000-0000-4000-8000-000000001608';
    const BOILER = 'd0000000-0000-4000-8000-000000001609';
    for (const [id, jobNumber] of [[BOILER, 'JOB-0004'], ['d0000000-0000-4000-8000-000000001610', 'JOB-0005']] as const) {
      await jobRepo.create({
        id, tenantId: TENANT, customerId: OWNER, locationId: 'loc-keller', jobNumber, summary: 'Boiler work',
        status: 'scheduled', priority: 'normal', createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED,
      } as Job);
    }
    await openInvoice(BOILER, 'INV-0103', 9000);
    await openInvoice('d0000000-0000-4000-8000-000000001610', 'INV-0104', 25000);
    const onJob = await ask('what does this job owe?', { customerId: OWNER, jobId: BOILER });
    expect(onJob?.outcome).toBe('answered');
    expect(onJob?.message.content).toContain('$90');
    expect(onJob?.message.content).not.toContain('$340');
  });

  it('"when is this appointment?" on a past visit\'s page answers for that visit, not the next one', async () => {
    const d = await deps();
    const appointmentRepo = d.shared.appointmentRepo as InMemoryAppointmentRepository;
    await appointmentRepo.create({
      id: 'appt-keller-past', tenantId: TENANT, jobId: JOB_KELLER, timezone: TZ, status: 'completed',
      holdPendingApproval: false, createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED,
      scheduledStart: new Date('2026-06-05T14:00:00.000Z'), scheduledEnd: new Date('2026-06-05T16:00:00.000Z'),
    } as Appointment);
    const ask = (appointmentId: string) =>
      dispatchAssistantLookup(
        {
          tenantId: TENANT,
          userId: MIKE_CLERK,
          intent: 'lookup_appointments',
          extractedEntities: {},
          message: 'when is this appointment?',
          page: { customerId: 'cust-keller', jobId: JOB_KELLER, appointmentId },
        },
        { ...d, answers: { ...d.answers, resolveMemberRole: async () => 'owner' } },
      );

    const past = await ask('appt-keller-past');
    expect(past?.outcome).toBe('answered');
    expect(past?.message.content).toContain('This visit was Friday, June 5');
    expect(past?.message.content).not.toContain('June 11');

    // A visit that is gone says so, rather than answering with the customer's next one.
    const missing = await ask('appt-gone');
    expect(missing?.message.content).toContain("I couldn't find the visit you were viewing.");
    expect(missing?.message.content).not.toContain('June 11');
  });
});
