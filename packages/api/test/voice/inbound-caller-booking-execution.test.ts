/**
 * Inbound caller booking — EXECUTION proof (the seam nothing crosses).
 *
 * Two existing suites each cover one HALF of the inbound-caller story and
 * are bridged by a hand-written payload, so the join between them has
 * never been exercised:
 *
 *   - test/voice/inbound-caller-booking-golden-path.test.ts PRODUCES a
 *     real-path proposal via `createVoiceTurnProcessor.speechTurn` — then
 *     stops. It never executes what it produced. (It also USED to assert
 *     that the raw classifier strings survived into `payload.entities`,
 *     i.e. it encoded the broken shape as correct; those assertions are
 *     now written against the flat contract.)
 *   - test/integration/voice-inbound-appointment.test.ts EXECUTES through
 *     the production `createExecutionHandlerRegistry` + `ProposalExecutor`
 *     — but hand-writes `payload: { jobId, scheduledStart, ... }` under
 *     the comment "What the voice task handler emits for a cold inbound
 *     call". Nothing proves the real path emits that shape.
 *
 * It did not. `handleCreateProposal` in
 * `src/ai/voice-turn/create-voice-turn-processor.ts` persisted a NESTED
 * envelope — `{ intent, entities, sessionId, callSid }` — while every
 * execution handler reads FLAT keys (`payload.customerId`,
 * `payload.jobId`, `payload.scheduledStart`, `payload.appointmentId`, …),
 * and the Gather/media-streams "entity resolution" step was a verbatim ECHO
 * of the classifier, so no spoken reference ever became an id and no spoken
 * time ever became an ISO instant. The in-app adapter
 * (`customer-calling/inapp-adapter.ts`) had an explicit flat-promotion step
 * before `buildProposal`; the real Twilio phone path had no equivalent.
 *
 * This suite closes the seam: it drives the REAL path through both turns,
 * takes the proposal object EXACTLY AS THE CODE PRODUCED IT, approves it,
 * and runs it through the PRODUCTION execution registry + executor against
 * in-memory repositories.
 *
 * It was written RED (6 of 10 cases failing) as the proof of the defect. It
 * is now the regression guard for the fix: `proposals/voice-payload.ts`
 * (`buildVoiceProposalPayload`) owns the envelope→flat-contract translation
 * for the voice surfaces, the processor resolves entities through the shared
 * `resolveSchedulingEntities`, and a payload that cannot satisfy its contract
 * degrades to a canonical `voice_clarification` instead of persisting an
 * approve-to-fail card.
 *
 * INVARIANT FOR ANYONE EDITING THIS FILE: there is no `payload` literal
 * anywhere in it, and there must never be one. The moment a payload is
 * hand-written here, this suite stops testing the thing it exists for and
 * becomes a third copy of the bug.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createVoiceTurnProcessor,
  type VoiceTurnProcessor,
} from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  InMemoryProposalRepository,
  type Proposal,
  type ProposalType,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { InMemoryVoiceSessionRepository } from '../../src/voice/voice-session';
import { InMemoryPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import type { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../src/ai/resolution/entity-resolver';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  type ExecutionContext,
  type ExecutionResult,
} from '../../src/proposals/execution/handlers';
import { S1_ALLOWED_PROPOSAL_TYPES } from '../../src/proposals/surface';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { guardVoiceProposalContract } from './helpers/voice-proposal-contract';

// The tradesperson's provisioned business number (what the AI answers on),
// the customer's caller-ID, and the tenant that owns the number — same
// fixture shape the golden-path suite uses.
const BUSINESS_NUMBER = '+15125550999';
const CALLER_NUMBER = '+15125550100';
const TENANT = 'tenant-hvac-inbound';
const CALL_SID = 'CA-inbound-execution-1';
const OWNER_USER = 'owner-user-1';

/** Gateway that replays one scripted JSON body per `complete()` call. */
function gatewaySequence(contents: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: contents[Math.min(i++, contents.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 8, output: 8, total: 16 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

/**
 * Everything the PRODUCTION execution registry needs, backed by in-memory
 * repositories, plus a pre-seeded world: the identified caller's customer
 * record, their service location, an open job, and an already-booked
 * appointment they could ask to move.
 *
 * The world is deliberately COMPLETE. Every id an execution handler could
 * legitimately need already exists in the tenant, so a failure here can
 * only mean the proposal payload failed to carry it — never that the
 * fixture was thin.
 */
interface World {
  customerRepo: InMemoryCustomerRepository;
  locationRepo: InMemoryLocationRepository;
  jobRepo: InMemoryJobRepository;
  appointmentRepo: InMemoryAppointmentRepository;
  estimateRepo: InMemoryEstimateRepository;
  settingsRepo: InMemorySettingsRepository;
  /**
   * The tenant's price book. Production wires this into the voice-turn
   * processor (app.ts `twilioAdapterDeps.catalogRepo`) so a spoken quote is
   * priced from the catalog and never from an LLM guess; without it the
   * grounded line items carry NO price and `normalizeDraftLineItems` rejects
   * them ("has no usable unit price"). Part of "the world is complete".
   */
  catalogRepo: InMemoryCatalogItemRepository;
  auditRepo: InMemoryAuditRepository;
  customerId: string;
  locationId: string;
  jobId: string;
  appointmentId: string;
}

/**
 * Tenant-scoped entity resolver over the seeded world — the fixture stand-in
 * for production's `AliasFirstEntityResolver → PgEntityResolver` (pg_trgm).
 *
 * Deliberately a RESOLVER, not a lookup table: it matches a free-text reference
 * against what actually exists in the tenant and obeys the EntityResolver
 * contract (one match → resolved, several → ambiguous, none → not_found), so
 * the suite still proves the real path RESOLVES ("my Tuesday furnace
 * appointment" → an appointment UUID) rather than that the fixture handed an id
 * over. Nothing here writes a payload field.
 */
function makeWorldEntityResolver(world: World): EntityResolver {
  /**
   * Distinctive (>=5 char) words — the ones a caller's phrasing and a record's
   * own name actually share. "my Tuesday FURNACE appointment" vs the job
   * "FURNACE not heating"; "Dana REYES" vs the customer "Dana Reyes".
   */
  const distinctive = (s: string): string[] => [
    ...new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 5),
    ),
  ];

  /**
   * The EntityResolver contract, verbatim: exactly one match → resolved,
   * several → ambiguous (a one-tap clarification, never a silent pick), none →
   * not_found. `score` reports how much of the record's own name the caller
   * said, for the candidate list.
   */
  const best = (
    reference: string,
    kind: 'customer' | 'job' | 'appointment',
    rows: Array<{ id: string; label: string }>,
  ): EntityResolverResult => {
    const spoken = new Set(distinctive(reference));
    const scored = rows
      .map((r) => {
        const words = distinctive(r.label);
        const hits = words.filter((w) => spoken.has(w)).length;
        return {
          id: r.id,
          kind,
          label: r.label,
          score: words.length === 0 ? 0 : hits / words.length,
          hits,
        };
      })
      .filter((c) => c.hits > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { kind: 'not_found', reference };
    if (scored.length > 1) {
      return { kind: 'ambiguous', candidates: scored.map(({ hits: _h, ...c }) => c) };
    }
    const { hits: _hits, ...candidate } = scored[0];
    return { kind: 'resolved', candidate };
  };

  return {
    async resolve({ tenantId, reference, kind }) {
      if (kind === 'customer') {
        const customers = await world.customerRepo.findByTenant(tenantId);
        return best(
          reference,
          'customer',
          customers.map((c) => ({ id: c.id, label: c.displayName })),
        );
      }
      if (kind === 'job') {
        const jobs = await world.jobRepo.findByTenant(tenantId);
        return best(
          reference,
          'job',
          jobs.map((j) => ({ id: j.id, label: j.summary })),
        );
      }
      if (kind === 'appointment') {
        // An appointment has no name of its own — production resolves the
        // caller's phrase against the appointment's date and its JOB, which is
        // what "my Tuesday furnace appointment" actually names.
        const { data } = await world.appointmentRepo.listWithMeta(tenantId);
        const labelled = await Promise.all(
          data.map(async (a) => {
            const job = await world.jobRepo.findById(tenantId, a.jobId);
            return { id: a.id, label: job?.summary ?? '' };
          }),
        );
        return best(reference, 'appointment', labelled);
      }
      return { kind: 'skipped' };
    },
  };
}

async function seedWorld(): Promise<World> {
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const jobRepo = new InMemoryJobRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const catalogRepo = new InMemoryCatalogItemRepository();
  const auditRepo = new InMemoryAuditRepository();

  // U4 — the tenant's zone. Spoken times ("Tuesday at 2pm") only resolve
  // against a CONFIGURED tenant timezone now (never a silent UTC frame), so
  // the world carries one the way every onboarded production tenant does.
  await settingsRepo.create({
    id: 'settings-exec-1',
    tenantId: TENANT,
    businessName: 'Rivet HVAC',
    timezone: 'America/Chicago',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Parameters<InMemorySettingsRepository['create']>[0]);

  // The tenant's price book. A caller can only be quoted for work the
  // tradesperson actually sells, so the two services this suite's caller asks
  // about are in it — that is what makes the drafted estimate's lines
  // catalog-priced (`pricingSource: 'catalog'`) instead of unpriced.
  for (const [name, unitPriceCents] of [
    ['water heater flush', 18_900],
    ['thermostat replacement', 32_500],
  ] as const) {
    await catalogRepo.create(
      createCatalogItem({
        tenantId: TENANT,
        name,
        category: 'Labor',
        unit: 'each',
        unitPriceCents,
      }),
    );
  }

  const customerId = randomUUID();
  const locationId = randomUUID();
  const jobId = randomUUID();
  const appointmentId = randomUUID();
  const now = new Date();

  await customerRepo.create({
    id: customerId,
    tenantId: TENANT,
    firstName: 'Dana',
    lastName: 'Reyes',
    displayName: 'Dana Reyes',
    primaryPhone: CALLER_NUMBER,
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: OWNER_USER,
    createdAt: now,
    updatedAt: now,
  });

  await locationRepo.create({
    id: locationId,
    tenantId: TENANT,
    customerId,
    street1: '123 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'USA',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  });

  await jobRepo.create({
    id: jobId,
    tenantId: TENANT,
    customerId,
    locationId,
    jobNumber: 'JOB-001',
    summary: 'Furnace not heating',
    status: 'scheduled',
    priority: 'normal',
    createdBy: OWNER_USER,
    createdAt: now,
    updatedAt: now,
  });

  const apptStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await appointmentRepo.create({
    id: appointmentId,
    tenantId: TENANT,
    jobId,
    scheduledStart: apptStart,
    scheduledEnd: new Date(apptStart.getTime() + 60 * 60 * 1000),
    timezone: 'America/Chicago',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: OWNER_USER,
    createdAt: now,
    updatedAt: now,
  });

  return {
    customerRepo,
    locationRepo,
    jobRepo,
    appointmentRepo,
    estimateRepo,
    settingsRepo,
    catalogRepo,
    auditRepo,
    customerId,
    locationId,
    jobId,
    appointmentId,
  };
}

interface InboundHarness {
  processor: VoiceTurnProcessor;
  store: VoiceSessionStore;
  proposalRepo: InMemoryProposalRepository;
  session: ReturnType<VoiceSessionStore['create']>;
  resolvedTenantId: string;
}

/**
 * Build the inbound engine the way production wires a Gather-mode call —
 * VERBATIM the harness from inbound-caller-booking-golden-path.test.ts,
 * with one addition: the identified caller's customerId is a real UUID
 * from the seeded world, so the FSM's caller identity is something the
 * execution handlers could actually resolve.
 *
 * The tenant is resolved from the dialed number up front (what
 * `resolveInboundTenantId` in routes/telephony.ts does); the HTTP
 * signature / prod-miss path is proven in
 * routes/telephony-tenant-lookup.test.ts.
 */
async function makeInboundCall(
  gateway: LLMGateway,
  world: World,
): Promise<InboundHarness> {
  const phoneRepo = new InMemoryPhoneNumberRepository({ [BUSINESS_NUMBER]: TENANT });
  const lookup = await phoneRepo.findByNumber(BUSINESS_NUMBER);
  if (!lookup) throw new Error('fixture: business number must resolve to a tenant');
  const resolvedTenantId = lookup.tenantId;

  const store = new VoiceSessionStore({ startInterval: false });
  const proposalRepo = guardVoiceProposalContract(new InMemoryProposalRepository());
  const voiceSessionRepo = new InMemoryVoiceSessionRepository();

  const session = store.create(resolvedTenantId, 'telephony', { callSid: CALL_SID });
  // Drive the inbound FSM to `intent_capture`, the point where a caller
  // utterance is classified. handleInbound's unknown-caller branch lands in
  // `ask_caller`; we emulate the identified-caller transition (the caller-ID
  // match a live pool would perform) so the booking turn runs — the same
  // bootstrap the twilio-adapter Gather tests use.
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: CALL_SID,
    from: CALLER_NUMBER,
    to: BUSINESS_NUMBER,
    tenantId: resolvedTenantId,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: world.customerId });
  session.customerId = world.customerId;

  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Rivet HVAC',
    systemActorId: 'calling-agent',
    auditRepo: world.auditRepo,
    proposalRepo,
    voiceSessionRepo,
    // Production wiring (app.ts `twilioAdapterDeps`) that the original harness
    // omitted, and whose absence the RED run hid behind an earlier failure:
    //  - `entityResolver`: turns the caller's spoken references into tenant
    //    ids and their spoken times into ISO instants. Without it nothing on
    //    the phone path ever resolves.
    //  - `catalogRepo`: prices a spoken quote from the tenant price book, so a
    //    drafted estimate's lines carry a real `unitPrice`.
    entityResolver: makeWorldEntityResolver(world),
    catalogRepo: world.catalogRepo,
    //  - `settingsRepo` (U4): the tenant zone the spoken times resolve
    //    against — production telephony threads it via twilioAdapterDeps.
    settingsRepo: world.settingsRepo,
  });

  return { processor, store, proposalRepo, session, resolvedTenantId };
}

const CONFIRM_YES = JSON.stringify({
  answer: 'yes',
  reasoning: 'caller confirmed the readback',
});

/**
 * One inbound-caller scenario per S1-allowlisted proposal type.
 *
 * `entities` holds ONLY what the intent classifier can actually emit
 * (`ai/orchestration/intent-classifier.ts` ExtractedEntities). It is
 * deliberately NOT a back door for payload fields: the caller's resolved
 * `customerId` reaches the proposal the way production supplies it — from
 * the identified session (`caller_known`), folded in by
 * `transitions.ts transitionIntentConfirm` — not from this table.
 */
interface RealPathCase {
  /** The S1-allowlisted proposal type this caller intent should produce. */
  proposalType: ProposalType;
  /** The classifier verdict for the caller's utterance. */
  intent: string;
  utterance: string;
  entities: Record<string, unknown>;
  /** Asserts the row the execution should have written. */
  expectRow: (world: World) => Promise<void>;
}

const RECORD_CREATING_CASES: RealPathCase[] = [
  {
    proposalType: 'create_appointment',
    intent: 'create_appointment',
    utterance: 'Hi, my furnace stopped heating — can someone come out Tuesday at 2pm?',
    entities: {
      jobReference: 'furnace not heating',
      jobTitle: 'furnace repair',
      dateTimeDescription: 'Tuesday at 2pm',
      customerName: 'Dana Reyes',
    },
    expectRow: async (world) => {
      const booked = await world.appointmentRepo.listWithMeta(TENANT);
      // One seeded appointment already exists; the booking adds a second.
      expect(booked.total).toBe(2);
    },
  },
  {
    proposalType: 'create_customer',
    intent: 'create_customer',
    utterance: "I'm a new customer — Casey Nguyen, my number's 512-555-0177.",
    entities: {
      displayName: 'Casey Nguyen',
      phone: '+15125550177',
    },
    expectRow: async (world) => {
      const customers = await world.customerRepo.findByTenant(TENANT);
      expect(customers.map((c) => c.displayName)).toContain('Casey Nguyen');
    },
  },
  {
    proposalType: 'create_job',
    intent: 'create_job',
    utterance: 'My water heater is leaking, can you open a job for that?',
    entities: {
      jobTitle: 'water heater replacement',
      jobReference: 'water heater leaking',
    },
    expectRow: async (world) => {
      const jobs = await world.jobRepo.findByTenant(TENANT);
      expect(jobs.map((j) => j.summary)).toContain('water heater replacement');
    },
  },
  {
    proposalType: 'reschedule_appointment',
    intent: 'reschedule_appointment',
    utterance: 'Can we move my Tuesday furnace appointment to Thursday at 10?',
    entities: {
      appointmentReference: 'my Tuesday furnace appointment',
      newDateTimeDescription: 'Thursday at 10am',
    },
    expectRow: async (world) => {
      const moved = await world.appointmentRepo.findById(TENANT, world.appointmentId);
      expect(moved).not.toBeNull();
      // The seeded slot is 48h out; a successful reschedule must have
      // moved it somewhere else.
      expect(moved!.scheduledStart.getTime()).not.toBe(
        new Date(Date.now() + 48 * 60 * 60 * 1000).getTime(),
      );
    },
  },
  {
    proposalType: 'draft_estimate',
    intent: 'draft_estimate',
    utterance: 'What would a water heater flush and a new thermostat run me?',
    entities: {
      lineItemDescriptions: ['water heater flush', 'thermostat replacement'],
      customerName: 'Dana Reyes',
    },
    expectRow: async (world) => {
      const estimates = await world.estimateRepo.findByTenant(TENANT);
      expect(estimates).toHaveLength(1);
    },
  },
];

/**
 * Drive the REAL inbound path end to end for one case and hand back the
 * proposal object exactly as `createVoiceTurnProcessor` persisted it.
 * Turn 1 = the caller's utterance (classify + readback), turn 2 = "yes"
 * (the confirmation that mints the proposal) — identical to the two turns
 * the golden-path suite drives.
 */
async function driveRealPathProposal(
  c: RealPathCase,
  world: World,
): Promise<Proposal[]> {
  const classification = JSON.stringify({
    intentType: c.intent,
    confidence: 0.92,
    reasoning: `inbound caller wants ${c.intent}`,
    extractedEntities: c.entities,
  });
  const h = await makeInboundCall(gatewaySequence([classification, CONFIRM_YES]), world);

  await h.processor.speechTurn({
    session: h.session,
    speechResult: c.utterance,
    callSid: CALL_SID,
    tenantId: h.resolvedTenantId,
  });
  await h.processor.speechTurn({
    session: h.session,
    speechResult: 'Yes, that works',
    callSid: CALL_SID,
    tenantId: h.resolvedTenantId,
  });

  return h.proposalRepo.findByTenant(h.resolvedTenantId);
}

/**
 * Approve the proposal the owner sees and execute it through the
 * PRODUCTION registry + executor. No payload is touched: `proposal` goes
 * in exactly as the voice path built it.
 */
async function approveAndExecute(
  proposal: Proposal,
  world: World,
): Promise<ExecutionResult> {
  let approved = transitionProposal(proposal, 'ready_for_review', OWNER_USER);
  approved = transitionProposal(approved, 'approved', OWNER_USER);
  // Step past the 5s undo window so the executor will run it.
  approved = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

  const proposalRepo = guardVoiceProposalContract(new InMemoryProposalRepository());
  await proposalRepo.create(approved);
  const executionRepo = new InMemoryProposalExecutionRepository();

  // The SAME dep bundle app.ts hands createExecutionHandlerRegistry. The
  // scheduling repos are stubs (this suite models no crews, shifts or PTO), but
  // `jobRepo` is the world's: RescheduleAppointmentExecutionHandler's S1
  // ownership check (appointment → job → customerId) reads it off
  // `feasibilityDeps` and FAILS CLOSED without it, which would refuse a caller's
  // reschedule of their own appointment for a wiring reason rather than a
  // payload one.
  const feasibilityDeps: FeasibilityDependencies = {
    assignmentRepo: {
      findByTechnician: async () => [],
      findByAppointment: async () => [],
    } as unknown as FeasibilityDependencies['assignmentRepo'],
    appointmentRepo: world.appointmentRepo,
    jobRepo: world.jobRepo,
    locationRepo: world.locationRepo,
    workingHoursRepo: {
      findByTechnician: async () => [],
    } as unknown as FeasibilityDependencies['workingHoursRepo'],
    unavailableBlockRepo: {
      findByTechnicianAndDateRange: async () => [],
    } as unknown as FeasibilityDependencies['unavailableBlockRepo'],
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
  };

  const handlers = createExecutionHandlerRegistry({
    customerRepo: world.customerRepo,
    locationRepo: world.locationRepo,
    jobRepo: world.jobRepo,
    appointmentRepo: world.appointmentRepo,
    estimateRepo: world.estimateRepo,
    settingsRepo: world.settingsRepo,
    catalogRepo: world.catalogRepo,
    auditRepo: world.auditRepo,
    feasibilityDeps,
  });
  const executor = new ProposalExecutor(
    handlers,
    proposalRepo,
    new IdempotencyGuard(executionRepo, proposalRepo),
    world.auditRepo,
  );

  const context: ExecutionContext = { tenantId: TENANT, executedBy: OWNER_USER };
  const { result } = await executor.execute(approved, context);
  return result;
}

describe('Inbound caller — a real-path proposal must actually execute', () => {
  it('the S1 allowlist is the 8 types this suite parameterises over', () => {
    expect([...S1_ALLOWED_PROPOSAL_TYPES].sort()).toEqual(
      [
        'callback',
        'create_appointment',
        'create_booking',
        'create_customer',
        'create_job',
        'draft_estimate',
        'reschedule_appointment',
        'voice_clarification',
      ].sort(),
    );
  });

  it.each(RECORD_CREATING_CASES)(
    '$proposalType — caller says it, owner approves it, the row gets written',
    async (c) => {
      const world = await seedWorld();
      const proposals = await driveRealPathProposal(c, world);

      expect(
        proposals.length,
        `the real path produced ${proposals.length} proposals for intent '${c.intent}'`,
      ).toBe(1);
      const proposal = proposals[0]!;

      // The caller's intent must survive as the TYPE the owner approves.
      expect(proposal.proposalType).toBe(c.proposalType);
      expect(proposal.tenantId).toBe(TENANT);
      expect(proposal.status).toBe('draft');

      const result = await approveAndExecute(proposal, world);

      // Surface the handler's own words on failure — this is the line
      // that reports WHICH contract the real-path payload violated.
      expect(
        result.error ?? null,
        `execution of the real-path '${c.proposalType}' proposal failed`,
      ).toBeNull();
      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBeDefined();

      await c.expectRow(world);
    },
  );

  /**
   * `create_booking` is the one record-creating S1 type this suite does NOT
   * parameterise over, because the real phone path cannot reach it AT ALL —
   * a DIFFERENT gap from the flat-payload one, and deliberately not "fixed"
   * here.
   *
   * It is on the S1 allowlist and has a production execution handler, but no
   * classifier intent maps to it: the string is in neither
   * `intentToProposalType` (ai/voice-turn/create-voice-turn-processor.ts) nor
   * `SUPPORTED_INTENTS` (ai/orchestration/intent-classifier.ts). An utterance
   * classified as `create_booking` is therefore rejected as an unknown intent
   * BEFORE any proposal is minted — the FSM never reaches `intent_confirm`,
   * so turn 2's "yes" confirms nothing and ZERO proposals are written. That
   * is the correct fail-safe (never invent a booking the classifier can't
   * name), and this assertion pins it so the day someone adds the intent, the
   * missing payload contract has to be added with it.
   */
  it('create_booking is unreachable from the phone path — no classifier intent maps to it', async () => {
    const world = await seedWorld();
    const proposals = await driveRealPathProposal(
      {
        proposalType: 'create_booking',
        intent: 'create_booking',
        utterance: 'Yes, book me into that 2pm slot you just held.',
        entities: {
          dateTimeDescription: 'Tuesday at 2pm',
          jobReference: 'furnace not heating',
        },
        expectRow: async () => {},
      },
      world,
    );

    expect(
      proposals,
      'a create_booking utterance must mint NOTHING while no classifier intent maps to it',
    ).toEqual([]);
    // ...even though the type is otherwise fully executable.
    expect(S1_ALLOWED_PROPOSAL_TYPES.has('create_booking')).toBe(true);
    expect(createExecutionHandlerRegistry({}).has('create_booking')).toBe(true);
  });
});

/**
 * Control group. The other two S1-allowlisted types are NOT record-
 * creating: `callback` routes the caller to a human and
 * `voice_clarification` is an ask, not a mutation. These assertions are
 * expected to PASS, and they are what proves the harness above is sound:
 * the same two-turn drive against the same production registry works, so
 * a red case in the suite above is the payload contract and not the rig.
 *
 * The two types diverged on Task 14 (2026-08-07 tradesperson plan):
 * `callback` now HAS an execution handler (`CallbackExecutionHandler`,
 * `proposals/execution/callback-handler.ts`) — a deliberately dep-free
 * acknowledgement, registered unconditionally, that fixed the pre-existing
 * `HANDLER_NOT_FOUND` bug on an approved `callback` proposal.
 * `voice_clarification` still has none, but for a DIFFERENT reason: its
 * own version of "approving it must do something real" was solved by TYPE
 * TRANSITION rather than by an execution handler — `resolve-entity.ts`'s
 * one-tap resolution REPLACES the `voice_clarification` row with a freshly
 * drafted, executable typed proposal (e.g. `draft_invoice`) before
 * approval, so there is never an approved `voice_clarification` proposal
 * left needing an execution handler at all (see resolve-entity.ts's class
 * doc comment).
 */
describe('Inbound caller — the non-mutating S1 types (control)', () => {
  const registry = createExecutionHandlerRegistry({});

  it('voice_clarification is S1-allowed and has no execution handler (resolved by type transition — resolve-entity.ts)', () => {
    expect(S1_ALLOWED_PROPOSAL_TYPES.has('voice_clarification')).toBe(true);
    expect(registry.has('voice_clarification')).toBe(false);
  });

  it('callback is S1-allowed and HAS a dep-free acknowledgement handler (Task 14)', () => {
    expect(S1_ALLOWED_PROPOSAL_TYPES.has('callback')).toBe(true);
    expect(registry.has('callback')).toBe(true);
  });

  /**
   * The two tests above were, until Task 14, a single `it.each` that
   * asserted BOTH S1-allowed types lacked an execution handler — a red test
   * the moment `callback` got one, because the enumeration lived only in
   * that one assertion with no separate source of truth to check it against.
   * This test is that source of truth: it names, in ONE reviewed constant,
   * exactly which S1-allowed proposal types are intentionally handler-less
   * (today: only `voice_clarification`, resolved by type transition — see
   * the doc comment above). Any other S1-allowed type with no execution
   * handler is a real gap, not a documented exception, and should fail here
   * rather than surface as a runtime HANDLER_NOT_FOUND.
   */
  it('the only S1-allowed proposal type with no execution handler is voice_clarification', () => {
    const EXPECTED_HANDLERLESS_S1_TYPES = ['voice_clarification'];
    const actuallyHandlerless = [...S1_ALLOWED_PROPOSAL_TYPES].filter(
      (type) => !registry.has(type),
    );
    expect(actuallyHandlerless).toEqual(EXPECTED_HANDLERLESS_S1_TYPES);
  });

  it('an operator-only ask from a caller is blocked at classification — nothing minted (#887)', async () => {
    // Pre-#887 this ask rode the S1 coercion into a voice_clarification
    // proposal (after a confirm dance that ended in a false success line).
    // The classifier's post-parse surface guard now maps send_invoice to
    // unknown/'intent_off_surface' on the caller profile, so the call
    // reprompts and NO proposal of any kind is persisted. The S1 coercion
    // itself remains as defense-in-depth behind the classifier gate
    // (pinned at the side-effect level in voice-turn-processor.test.ts).
    const world = await seedWorld();
    const proposals = await driveRealPathProposal(
      {
        proposalType: 'voice_clarification',
        intent: 'send_invoice',
        utterance: 'Can you send me the Henderson invoice by email?',
        entities: { customerName: 'Henderson', sendChannel: 'email' },
        expectRow: async () => {},
      },
      world,
    );

    expect(proposals).toHaveLength(0);
  });
});
