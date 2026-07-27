/**
 * Inbound caller booking — EXECUTION proof (the seam nothing crosses).
 *
 * Two existing suites each cover one HALF of the inbound-caller story and
 * are bridged by a hand-written payload, so the join between them has
 * never been exercised:
 *
 *   - test/voice/inbound-caller-booking-golden-path.test.ts PRODUCES a
 *     real-path proposal via `createVoiceTurnProcessor.speechTurn` and
 *     asserts the raw classifier strings survive into `payload.entities`
 *     — then stops. It never executes what it produced.
 *   - test/integration/voice-inbound-appointment.test.ts EXECUTES through
 *     the production `createExecutionHandlerRegistry` + `ProposalExecutor`
 *     — but hand-writes `payload: { jobId, scheduledStart, ... }` under
 *     the comment "What the voice task handler emits for a cold inbound
 *     call". Nothing proves the real path emits that shape.
 *
 * It does not. `handleCreateProposal` in
 * `src/ai/voice-turn/create-voice-turn-processor.ts` persists a NESTED
 * envelope — `{ intent, entities, sessionId, callSid }` — while every
 * execution handler reads FLAT keys (`payload.customerId`,
 * `payload.jobId`, `payload.scheduledStart`, `payload.appointmentId`, …).
 * The in-app adapter (`customer-calling/inapp-adapter.ts`) has an explicit
 * flat-promotion step before `buildProposal`; the real Twilio phone path
 * has no equivalent. `customer-calling/transitions.ts` even documents the
 * asymmetry in a comment on the emergency side effect ("Duplicated into
 * entities because the voice-turn processor's handleCreateProposal
 * persists only {intent, entities, sessionId, callSid}").
 *
 * This suite closes the seam: it drives the REAL path through both turns,
 * takes the proposal object EXACTLY AS THE CODE PRODUCED IT, approves it,
 * and runs it through the PRODUCTION execution registry + executor against
 * in-memory repositories.
 *
 * *** THIS SUITE IS EXPECTED TO BE RED. ***
 * It is the proof of the defect, not a regression guard for a fix. The
 * companion golden-path suite stays GREEN against the same code path —
 * that contrast is the whole statement of the problem.
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
  auditRepo: InMemoryAuditRepository;
  customerId: string;
  locationId: string;
  jobId: string;
  appointmentId: string;
}

async function seedWorld(): Promise<World> {
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const jobRepo = new InMemoryJobRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const auditRepo = new InMemoryAuditRepository();

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
  const proposalRepo = new InMemoryProposalRepository();
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
  {
    // `create_booking` is on the S1 allowlist and has a production
    // handler, but NO classifier intent maps to it: neither
    // `intentToProposalType` (voice-turn/create-voice-turn-processor.ts)
    // nor `SUPPORTED_INTENTS` (ai/orchestration/intent-classifier.ts)
    // knows the string. Included so the parameterised run states, in
    // output rather than in prose, that the real phone path cannot reach
    // it at all — a DIFFERENT gap from the flat-payload one.
    proposalType: 'create_booking',
    intent: 'create_booking',
    utterance: 'Yes, book me into that 2pm slot you just held.',
    entities: {
      dateTimeDescription: 'Tuesday at 2pm',
      jobReference: 'furnace not heating',
    },
    expectRow: async (world) => {
      const held = await world.appointmentRepo.findById(TENANT, world.appointmentId);
      expect(held?.holdPendingApproval).toBe(false);
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

  const proposalRepo = new InMemoryProposalRepository();
  await proposalRepo.create(approved);
  const executionRepo = new InMemoryProposalExecutionRepository();

  const handlers = createExecutionHandlerRegistry({
    customerRepo: world.customerRepo,
    locationRepo: world.locationRepo,
    jobRepo: world.jobRepo,
    appointmentRepo: world.appointmentRepo,
    estimateRepo: world.estimateRepo,
    settingsRepo: world.settingsRepo,
    auditRepo: world.auditRepo,
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
});

/**
 * Control group. The other two S1-allowlisted types are NOT record-
 * creating: `callback` routes the caller to a human and
 * `voice_clarification` is an ask, not a mutation. Neither has an entry
 * in the production execution registry — by design. These assertions are
 * expected to PASS, and they are what proves the harness above is sound:
 * the same two-turn drive against the same production registry works, so
 * a red case in the suite above is the payload contract and not the rig.
 */
describe('Inbound caller — the non-mutating S1 types (control)', () => {
  const registry = createExecutionHandlerRegistry({});

  it.each(['callback', 'voice_clarification'] as ProposalType[])(
    '%s is S1-allowed but has no execution handler (never executed by design)',
    (type) => {
      expect(S1_ALLOWED_PROPOSAL_TYPES.has(type)).toBe(true);
      expect(registry.has(type)).toBe(false);
    },
  );

  it('an operator-only ask from a caller is coerced to voice_clarification', async () => {
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

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposalType).toBe('voice_clarification');
  });
});
