/**
 * #1604 — "Read me the next job" on the live phone, through the production
 * turn engine. Seam: `createVoiceTurnProcessor().speechTurn` with the session
 * established the way `establishInboundSession` composes it — the owner line
 * (RV-070 `ownerSession` + the D-026 actor), a technician calling from their
 * registered mobile (actor, no customer identity), and an unknown caller with
 * no actor at all. The shared dispatch does the scoping; this pins what each
 * line HEARS, in the issue's spoken order, including the Spanish readback on
 * an es session.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer, type Customer } from '../../../src/customers/customer';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../../src/appointments/appointment';
import { InMemoryJobRepository, type Job } from '../../../src/jobs/job';
import { InMemoryLocationRepository, type ServiceLocation } from '../../../src/locations/location';
import { InMemoryNoteRepository } from '../../../src/notes/note';
import { InMemoryUserRepository } from '../../../src/users/user';
import type { PhoneLookupDeps } from '../../../src/ai/voice-turn/phone-lookup-surface';
import type { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1604-phone';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York (11:00 UTC).
const NOW = new Date('2026-06-11T11:00:00.000Z');
const SEEDED = new Date('2026-06-01T00:00:00.000Z');

const OWNER_PHONE = '+15125550100';
const OWNER_ACTOR = 'user-1604-owner';
const TECH_MOBILE = '+15125550177';
const MIKE_CLERK = 'clerk-1604-mike';
const MIKE = 'tech-1604-mike';
const CARLOS = 'tech-1604-carlos';
const KELLER_PHONE = '+15125550123';
const JOB_KELLER = 'b0000000-0000-4000-8000-000000001604';
const JOB_PATEL = 'b0000000-0000-4000-8000-000000001605';

/**
 * A classifier stub. The OWNER line routes the bare asks deterministically
 * (the extended-intents phrase table, gated on the owner session's
 * `extendedIntents`) so its stub never names the intent; the technician and
 * customer lines have no short-circuit — there the live model classifies, and
 * the stub stands in for the model's answer.
 */
function classifier(intentType: string, confidence: number): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ intentType, confidence, extractedEntities: {} }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  } as unknown as LLMGateway;
}
const unknownClassifier = () => classifier('unknown', 0.2);
const modelSaysNextJob = () => classifier('lookup_next_job', 0.96);

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function lookupLines(fx: SideEffect[]): string[] {
  return fx
    .filter((f) => f.type === 'tts_play' && (f.payload as { source?: string }).source === 'lookup_skill')
    .map((f) => String((f.payload as { text?: string }).text ?? ''));
}

async function world(gateway: LLMGateway) {
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const jobRepo = new InMemoryJobRepository();
  const locationRepo = new InMemoryLocationRepository();
  const noteRepo = new InMemoryNoteRepository();
  const userRepo = new InMemoryUserRepository();

  // The owner is also a customer record on their own phone (the live owner-line fixture shape).
  const owner = await createCustomer(
    { tenantId: TENANT, firstName: 'Sam', lastName: 'Owner', primaryPhone: OWNER_PHONE, createdBy: 'test' },
    customerRepo,
  );
  const customer = (over: Partial<Customer>): Customer =>
    ({ tenantId: TENANT, preferredChannel: 'phone', smsConsent: false, isArchived: false, createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED, ...over }) as Customer;
  await customerRepo.create(customer({ id: 'cust-keller', firstName: 'Dana', lastName: 'Keller', displayName: 'Dana Keller', primaryPhone: '+15125550123' }));
  await customerRepo.create(customer({ id: 'cust-patel', firstName: 'Priya', lastName: 'Patel', displayName: 'Priya Patel', primaryPhone: '+15125550288' }));

  const location = (over: Partial<ServiceLocation>): ServiceLocation =>
    ({ tenantId: TENANT, state: 'NY', country: 'US', isPrimary: true, addressType: 'service', isArchived: false, createdAt: SEEDED, updatedAt: SEEDED, ...over }) as ServiceLocation;
  await locationRepo.create(location({ id: 'loc-keller', customerId: 'cust-keller', street1: '4120 East Oakhurst Boulevard', city: 'Yonkers', postalCode: '10701', accessNotes: 'Gate code 4421, dog in the yard' }));
  await locationRepo.create(location({ id: 'loc-patel', customerId: 'cust-patel', street1: '88 Mill Lane', city: 'Tarrytown', postalCode: '10591' }));

  const job = (over: Partial<Job>): Job =>
    ({ tenantId: TENANT, status: 'scheduled', priority: 'normal', createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED, ...over }) as Job;
  await jobRepo.create(job({ id: JOB_KELLER, customerId: 'cust-keller', locationId: 'loc-keller', jobNumber: 'JOB-0001', summary: 'Water heater replacement', assignedTechnicianId: MIKE }));
  await jobRepo.create(job({ id: JOB_PATEL, customerId: 'cust-patel', locationId: 'loc-patel', jobNumber: 'JOB-0002', summary: 'AC tune-up', assignedTechnicianId: CARLOS }));

  const appointment = (over: Partial<Appointment>): Appointment =>
    ({ tenantId: TENANT, timezone: TZ, status: 'scheduled', holdPendingApproval: false, createdBy: 'u1', createdAt: SEEDED, updatedAt: SEEDED, ...over }) as Appointment;
  await appointmentRepo.create(appointment({ id: 'appt-keller', jobId: JOB_KELLER, scheduledStart: new Date('2026-06-11T18:00:00.000Z'), scheduledEnd: new Date('2026-06-11T20:00:00.000Z') }));
  await appointmentRepo.create(appointment({ id: 'appt-patel', jobId: JOB_PATEL, scheduledStart: new Date('2026-06-11T13:00:00.000Z'), scheduledEnd: new Date('2026-06-11T14:00:00.000Z') }));

  await noteRepo.create({ id: 'note-keller', tenantId: TENANT, entityType: 'job', entityId: JOB_KELLER, content: 'Customer prefers a text before arrival.', authorId: 'u1', authorRole: 'owner', isPinned: false, createdAt: SEEDED, updatedAt: SEEDED });

  await userRepo.create({ id: MIKE, tenantId: TENANT, clerkUserId: MIKE_CLERK, email: 'mike@example.com', role: 'technician', firstName: 'Mike', lastName: 'Diaz', canFieldServe: true, mobileNumber: TECH_MOBILE });
  await userRepo.create({ id: CARLOS, tenantId: TENANT, email: 'carlos@example.com', role: 'technician', firstName: 'Carlos', lastName: 'Ruiz', canFieldServe: true });

  const lookups: PhoneLookupDeps = {
    answers: {
      resolveMemberRole: async (_t, userId) => (userId === OWNER_ACTOR ? 'owner' : userId === MIKE_CLERK ? 'technician' : null),
      locationRepo,
      noteRepo,
    },
    shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo, userRepo },
    tenantTimezoneResolver: async () => TZ,
    now: () => NOW,
  };
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
    appointmentRepo,
    jobRepo,
    lookups,
    now: () => NOW,
  });
  return { store, processor, proposalRepo, owner };
}

type Line = { callSid: string; from: string; ownerSession?: boolean; actorUserId?: string; customerId?: string; language?: 'en' | 'es' };

/** `establishInboundSession`'s composition: the owner line carries extendedIntents (flag default-on, #1588). */

function establish(store: VoiceSessionStore, line: Line) {
  const session = store.create(TENANT, 'telephony', {
    callSid: line.callSid,
    ...(line.ownerSession ? { ownerSession: true, extendedIntents: true } : {}),
  });
  session.machine.dispatch({ type: 'incoming_call', callSid: line.callSid, from: line.from, to: '+15125550999', tenantId: TENANT });
  session.machine.dispatch({ type: 'greeted_ok' });
  if (line.customerId) {
    session.machine.dispatch({ type: 'caller_known', customerId: line.customerId });
    session.customerId = line.customerId;
  } else {
    session.machine.dispatch({ type: 'unknown_caller' });
  }
  session.callerPhone = line.from;
  if (line.actorUserId) session.actorUserId = line.actorUserId;
  if (line.language) session.language = line.language;
  return session;
}

describe('#1604 — "Read me the next job" through speechTurn', () => {
  it("the OWNER line hears the business's next visit, with the technician (deterministic phrasing, no model call)", async () => {
    const w = await world(unknownClassifier());
    const session = establish(w.store, { callSid: 'CA-1604-owner', from: OWNER_PHONE, ownerSession: true, actorUserId: OWNER_ACTOR, customerId: w.owner.id });

    const fx = await w.processor.speechTurn({ session, speechResult: 'Read me the next job', callSid: 'CA-1604-owner', tenantId: TENANT });

    expect(lookupLines(fx)).toEqual([
      'The next job is today at 9 AM — Priya Patel, AC tune-up, at 88 Mill Lane, Tarrytown, with Carlos Ruiz.',
    ]);
    expect(await w.proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('the TECHNICIAN line (registered mobile → D-026 actor, no customer identity) hears only their own next visit', async () => {
    const w = await world(modelSaysNextJob());
    const session = establish(w.store, { callSid: 'CA-1604-tech', from: TECH_MOBILE, actorUserId: MIKE_CLERK });

    const fx = await w.processor.speechTurn({ session, speechResult: "What's my next job?", callSid: 'CA-1604-tech', tenantId: TENANT });

    expect(lookupLines(fx)).toEqual([
      'Your next job is today at 2 PM — Dana Keller, Water heater replacement, at 4120 East Oakhurst Boulevard, Yonkers. ' +
        'Access notes: Gate code 4421, dog in the yard. Latest note: Customer prefers a text before arrival.',
    ]);
    expect(JSON.stringify(fx)).not.toContain('Priya');
  });

  it('an identified CUSTOMER with NO actor hears the identity line — not data, not "owner-level report"', async () => {
    // Caller-ID matched Dana Keller's record (a customer, not a team member):
    // the phone surface's default-deny must refuse with an IDENTITY line.
    const w = await world(modelSaysNextJob());
    const session = establish(w.store, { callSid: 'CA-1604-customer', from: KELLER_PHONE, customerId: 'cust-keller' });

    const fx = await w.processor.speechTurn({ session, speechResult: 'Read me the next job', callSid: 'CA-1604-customer', tenantId: TENANT });

    expect(lookupLines(fx)).toEqual([
      "I couldn't match your number to a team member, so I can't read your next job. Let me get a person to help.",
    ]);
    expect(JSON.stringify(fx)).not.toContain('Mill Lane');
    expect(JSON.stringify(fx)).not.toContain('Oakhurst');
  });

  it('an es session hears the readback in Spanish', async () => {
    const w = await world(modelSaysNextJob());
    const session = establish(w.store, { callSid: 'CA-1604-es', from: TECH_MOBILE, actorUserId: MIKE_CLERK, language: 'es' });

    const fx = await w.processor.speechTurn({ session, speechResult: "What's my next job?", callSid: 'CA-1604-es', tenantId: TENANT });

    expect(lookupLines(fx)).toEqual([
      'Su próximo trabajo es hoy a las 2 p.m. — Dana Keller, Water heater replacement, en 4120 East Oakhurst Boulevard, Yonkers. ' +
        'Notas de acceso: Gate code 4421, dog in the yard. Última nota: Customer prefers a text before arrival.',
    ]);
  });
});
