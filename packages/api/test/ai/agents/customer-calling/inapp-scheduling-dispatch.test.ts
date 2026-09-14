/**
 * In-app 50-case register — the "Scheduling & dispatch" cluster, driven
 * through the REAL adapter (`InAppVoiceAdapter` → `CallingAgentStateMachine`
 * → `resolveSchedulingEntities` → `buildVoiceProposalPayload` →
 * `InMemoryProposalRepository`) with only the LLM classifier scripted and a
 * MOCKED `EntityResolver` (no DB), exactly the recipe
 * `inapp-entity-resolution-safety.test.ts` established.
 *
 * One test per register case (fixtures/voice/inapp-50-cases.json):
 *
 *   book-02     "Slot Carlos at Garcia Tuesday two o'clock for the install"
 *               → a NAMED technician lands as a verified `technicianId` on
 *                 the create_appointment payload, never silently dropped.
 *   delay-01    "Text Garcia that I'm running twenty minutes late"
 *               → the operator names the PERSON; with exactly one upcoming
 *                 appointment for that customer the notice attaches to it
 *                 with NO clarification.
 *   confirm-01  "Confirm Garcia for Tuesday"
 *               → the day phrase resolves to that appointment's id.
 *   cancel-02   "Cancel the Patel appointment" (Patel does not exist)
 *               → an honest spoken not-found, session back in
 *                 `intent_capture`, and NO on-call page.
 *   dispatch-03 "On my way to the Garcia job"
 *               → the shared audited en-route act, a spoken confirmation, no
 *                 proposal, and never a `voice_clarification` card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';
import type { SettingsRepository } from '../../../../src/settings/settings';
import {
  INAPP_EN_ROUTE_NO_TIMEZONE_LINE,
  INAPP_EN_ROUTE_UNAVAILABLE_LINE,
  INAPP_NO_ACTOR_EN_ROUTE_LINE,
  type InAppEnRouteDeps,
} from '../../../../src/ai/voice-turn/inapp-en-route-surface';
import type { Appointment } from '../../../../src/appointments/appointment';
import type { AppointmentAssignment } from '../../../../src/appointments/assignment';
import type { Job } from '../../../../src/jobs/job';
import type { Customer } from '../../../../src/customers/customer';
import type { User } from '../../../../src/users/user';
import type { EnRouteEnqueuer } from '../../../../src/dispatch/routes';

const TENANT = 'tenant-sched';
/** The authenticated operator's Clerk subject (what the route passes). */
const USER = 'clerk-operator-1';
/** …and their canonical `users.id`. */
const USER_ROW_ID = '44444444-4444-4444-8444-444444444444';
const TZ = 'America/Phoenix';

const CUSTOMER_GARCIA = '11111111-1111-4111-8111-111111111111';
const TECH_CARLOS = '22222222-2222-4222-8222-222222222222';
const APPT_GARCIA = '33333333-3333-4333-8333-333333333333';

function scriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

type ResolverCall = {
  kind: string;
  reference: string;
  jobId?: string;
  customerId?: string;
};

/**
 * A resolver over a fixed fixture world, driven by (kind, reference) and the
 * SCH-D2 customer anchor. Records every call so a test can assert HOW the
 * lookup was scoped, not just what came back.
 */
function fixtureResolver(
  answer: (call: ResolverCall) => EntityResolverResult,
): EntityResolver & { calls: ResolverCall[] } {
  const calls: ResolverCall[] = [];
  return {
    calls,
    resolve: vi.fn(async (input) => {
      const call: ResolverCall = {
        kind: input.kind,
        reference: input.reference,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.customerId ? { customerId: input.customerId } : {}),
      };
      calls.push(call);
      return answer(call);
    }),
  };
}

function resolved(id: string, kind: string, label: string): EntityResolverResult {
  return {
    kind: 'resolved',
    candidate: { id, kind: kind as never, label, score: 1 },
  };
}

const settingsRepo = {
  findByTenant: async () => ({ tenantId: TENANT, timezone: TZ }),
} as unknown as SettingsRepository;

describe('in-app scheduling & dispatch (50-case register cluster)', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository(
      new Map([[TENANT, [{ id: 'r1', userId: 'dispatcher-1', orderIndex: 0 }]]]),
    );
  });

  afterEach(() => store.dispose());

  function makeAdapter(opts: {
    classifier: string;
    entityResolver?: EntityResolver;
    enRoute?: InAppEnRouteDeps;
  }): InAppVoiceAdapter {
    return new InAppVoiceAdapter({
      store,
      gateway: scriptedGateway([opts.classifier]),
      proposalRepo,
      auditRepo,
      onCallRepo,
      settingsRepo,
      ...(opts.entityResolver ? { entityResolver: opts.entityResolver } : {}),
      ...(opts.enRoute ? { enRoute: opts.enRoute } : {}),
    });
  }

  const auditTypes = () => auditRepo.getAll().map((e) => e.eventType);

  // ── book-02 ──────────────────────────────────────────────────────────────
  describe('book-02 — a technician named on a booking lands as a verified technicianId', () => {
    const CLASSIFIER = JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.92,
      extractedEntities: {
        customerName: 'Garcia',
        dateTimeDescription: "Tuesday two o'clock",
        jobTitle: 'HVAC install',
        targetTechnicianName: 'Carlos',
      },
    });

    it('resolves Carlos and promotes technicianId into the create_appointment payload', async () => {
      const resolver = fixtureResolver((call) => {
        if (call.kind === 'customer') return resolved(CUSTOMER_GARCIA, 'customer', 'Garcia');
        if (call.kind === 'technician') return resolved(TECH_CARLOS, 'technician', 'Carlos');
        return { kind: 'not_found', reference: call.reference };
      });
      const adapter = makeAdapter({ classifier: CLASSIFIER, entityResolver: resolver });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn1 = await adapter.handleInput(
        sessionId,
        "Slot Carlos at Garcia Tuesday two o'clock for the install",
      );
      expect(turn1.state).toBe('intent_confirm');

      // The technician name WAS routed through the resolver (not left as free
      // text) — the whole point of SCHEDULING_TECHNICIAN_INTENTS.
      expect(resolver.calls).toContainEqual({ kind: 'technician', reference: 'Carlos' });

      const turn2 = await adapter.handleInput(sessionId, 'yes');
      expect(turn2.proposalIds).toHaveLength(1);

      const [proposal] = await proposalRepo.findByTenant(TENANT);
      expect(proposal.proposalType).toBe('create_appointment');
      expect(proposal.payload.technicianId).toBe(TECH_CARLOS);
      expect(proposal.payload.customerId).toBe(CUSTOMER_GARCIA);
      // "two o'clock" resolved in the TENANT's zone (2pm Phoenix = 21:00Z),
      // so the booking is complete and nothing gates it.
      expect(typeof proposal.payload.scheduledStart).toBe('string');
      expect(proposal.missingFields ?? []).toEqual([]);
      expect(auditTypes()).not.toContain('voice.payload_contract_failed');
    });

    it('an UNRESOLVED technician name never gates the booking (create is not record-operating)', async () => {
      const resolver = fixtureResolver((call) =>
        call.kind === 'customer'
          ? resolved(CUSTOMER_GARCIA, 'customer', 'Garcia')
          : { kind: 'not_found', reference: call.reference },
      );
      const adapter = makeAdapter({ classifier: CLASSIFIER, entityResolver: resolver });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn1 = await adapter.handleInput(sessionId, 'Slot Carlos at Garcia Tuesday');
      // NOT escalating: a booking whose named tech is unknown still books.
      expect(turn1.state).toBe('intent_confirm');
      expect(turn1.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(false);

      await adapter.handleInput(sessionId, 'yes');
      const [proposal] = await proposalRepo.findByTenant(TENANT);
      expect(proposal.proposalType).toBe('create_appointment');
      expect(proposal.payload.technicianId).toBeUndefined();
    });
  });

  // ── delay-01 ─────────────────────────────────────────────────────────────
  describe('delay-01 — a delay notice named by CUSTOMER attaches to their one upcoming appointment', () => {
    const CLASSIFIER = JSON.stringify({
      intentType: 'notify_delay',
      confidence: 0.94,
      extractedEntities: { customerName: 'Garcia', delayMinutes: 20 },
    });

    it('anchors the appointment lookup on the resolved customer and carries appointmentId into the payload', async () => {
      const resolver = fixtureResolver((call) => {
        if (call.kind === 'customer') return resolved(CUSTOMER_GARCIA, 'customer', 'Garcia');
        if (call.kind === 'appointment' && call.customerId === CUSTOMER_GARCIA) {
          return resolved(APPT_GARCIA, 'appointment', '2026-07-28T14:00:00.000Z');
        }
        return { kind: 'not_found', reference: call.reference };
      });
      const adapter = makeAdapter({ classifier: CLASSIFIER, entityResolver: resolver });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn1 = await adapter.handleInput(
        sessionId,
        "Text Garcia that I'm running twenty minutes late",
      );
      // No clarification: one upcoming appointment answers it outright.
      expect(turn1.state).toBe('intent_confirm');
      expect(
        turn1.sideEffects.some(
          (e) => e.type === 'tts_play' && e.payload.template === 'disambiguate',
        ),
      ).toBe(false);
      expect(resolver.calls).toContainEqual({
        kind: 'appointment',
        reference: '',
        customerId: CUSTOMER_GARCIA,
      });

      await adapter.handleInput(sessionId, 'yes');
      const [proposal] = await proposalRepo.findByTenant(TENANT);
      expect(proposal.proposalType).toBe('notify_delay');
      expect(proposal.payload.appointmentId).toBe(APPT_GARCIA);
      expect(proposal.payload.delayMinutes).toBe(20);
      expect(auditTypes()).not.toContain('voice.payload_contract_failed');
    });

    it('two upcoming appointments ask the existing one-tap question instead of picking one', async () => {
      const resolver = fixtureResolver((call) => {
        if (call.kind === 'customer') return resolved(CUSTOMER_GARCIA, 'customer', 'Garcia');
        return {
          kind: 'ambiguous',
          candidates: [
            { id: 'appt-1', kind: 'appointment', label: 'Tue 2:00 PM', score: 1 },
            { id: 'appt-2', kind: 'appointment', label: 'Thu 9:00 AM', score: 1 },
          ],
        };
      });
      const adapter = makeAdapter({ classifier: CLASSIFIER, entityResolver: resolver });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn1 = await adapter.handleInput(
        sessionId,
        "Text Garcia that I'm running twenty minutes late",
      );
      expect(turn1.state).toBe('entity_resolution');
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
      expect(auditTypes()).toContain('agent.calling.entity_resolution.entity_ambiguous');
    });
  });

  // ── confirm-01 ───────────────────────────────────────────────────────────
  it('confirm-01 — "Confirm Garcia for Tuesday" resolves the day phrase to an appointmentId', async () => {
    const resolver = fixtureResolver((call) => {
      if (call.kind === 'customer') return resolved(CUSTOMER_GARCIA, 'customer', 'Garcia');
      if (call.kind === 'appointment') {
        return resolved(APPT_GARCIA, 'appointment', '2026-07-28T14:00:00.000Z');
      }
      return { kind: 'not_found', reference: call.reference };
    });
    const adapter = makeAdapter({
      classifier: JSON.stringify({
        intentType: 'confirm_appointment',
        confidence: 0.93,
        extractedEntities: { customerName: 'Garcia', appointmentReference: 'Tuesday' },
      }),
      entityResolver: resolver,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

    const turn1 = await adapter.handleInput(sessionId, 'Confirm Garcia for Tuesday');
    expect(turn1.state).toBe('intent_confirm');
    // The SPOKEN reference keeps its own path — no customer anchor is added
    // when the classifier gave us words to resolve.
    const apptCall = resolver.calls.find((c) => c.kind === 'appointment');
    expect(apptCall).toMatchObject({ reference: 'Tuesday' });
    expect(apptCall?.customerId).toBeUndefined();

    await adapter.handleInput(sessionId, 'yes');
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal.proposalType).toBe('confirm_appointment');
    expect(proposal.payload.appointmentId).toBe(APPT_GARCIA);
    expect(auditTypes()).not.toContain('voice.payload_contract_failed');
  });

  // ── cancel-02 ────────────────────────────────────────────────────────────
  it('cancel-02 — a record that does not exist gets an honest not-found, NOT an on-call page', async () => {
    const resolver = fixtureResolver((call) => ({
      kind: 'not_found',
      reference: call.reference,
    }));
    const adapter = makeAdapter({
      classifier: JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.93,
        extractedEntities: {
          customerName: 'Patel',
          appointmentReference: 'the Patel appointment',
        },
      }),
      entityResolver: resolver,
    });
    const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

    const turn1 = await adapter.handleInput(sessionId, 'Cancel the Patel appointment');

    // Session stays in the operator's hands…
    expect(turn1.state).toBe('intent_capture');
    // …nobody is paged for an operator's own miss…
    expect(turn1.sideEffects.some((e) => e.type === 'notify_oncall')).toBe(false);
    expect(turn1.sideEffects.some((e) => e.type === 'end_session')).toBe(false);
    // …nothing is minted…
    expect(turn1.proposalIds).toHaveLength(0);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    // …and the line is honest and specific.
    expect(turn1.ttsText).toMatch(/couldn't find a matching appointment for the Patel appointment/i);
    expect(auditTypes()).toContain(
      'agent.calling.entity_resolution.entity_not_found_operator',
    );
    expect(auditTypes()).not.toContain('agent.calling.entity_resolution.entity_not_found');
  });

  // ── dispatch-03 ──────────────────────────────────────────────────────────
  describe('dispatch-03 — "On my way" fires the shared audited act, not a clarification card', () => {
    const CLASSIFIER = JSON.stringify({
      intentType: 'en_route',
      confidence: 0.95,
      extractedEntities: { jobReference: 'Garcia' },
    });
    const NOW = new Date('2026-07-28T18:00:00.000Z'); // 11:00 Phoenix

    function enRouteWorld(overrides: Partial<InAppEnRouteDeps> = {}) {
      const appointment = {
        id: APPT_GARCIA,
        tenantId: TENANT,
        jobId: 'job-garcia',
        scheduledStart: new Date('2026-07-28T21:00:00.000Z'), // 2pm Phoenix
        scheduledEnd: new Date('2026-07-28T22:00:00.000Z'),
        timezone: TZ,
        status: 'scheduled',
        holdPendingApproval: false,
      } as unknown as Appointment;
      const assignment = {
        id: 'assign-1',
        tenantId: TENANT,
        appointmentId: APPT_GARCIA,
        technicianId: USER_ROW_ID,
        isPrimary: true,
        assignedBy: USER_ROW_ID,
        assignedAt: NOW,
      } as unknown as AppointmentAssignment;
      // A REAL job summary says what the work is; "Garcia" lives only on the
      // customer, so this resolves only if job → customer is traversed.
      const job = {
        id: 'job-garcia',
        tenantId: TENANT,
        customerId: CUSTOMER_GARCIA,
        locationId: 'loc-1',
        jobNumber: 'JOB-0001',
        summary: 'HVAC install',
        status: 'scheduled',
        priority: 'normal',
      } as unknown as Job;
      const customer = {
        id: CUSTOMER_GARCIA,
        tenantId: TENANT,
        firstName: 'Garcia',
        lastName: '',
        displayName: 'Garcia',
        preferredChannel: 'sms',
        smsConsent: true,
        isArchived: false,
      } as unknown as Customer;
      const operator = {
        id: USER_ROW_ID,
        tenantId: TENANT,
        clerkUserId: USER,
        email: 'carlos@example.com',
        role: 'technician',
        firstName: 'Carlos',
        lastName: '',
      } as unknown as User;
      const enqueueEnRouteNotice = vi.fn(async () => 'appt:en_route');
      const enRouteCoordinator: EnRouteEnqueuer = { enqueueEnRouteNotice };
      const auditCreate = vi.fn(async () => undefined);

      const deps: InAppEnRouteDeps = {
        userRepo: { findByTenant: async () => [operator] },
        assignmentRepo: { findByTechnician: vi.fn(async () => [assignment]) },
        appointmentRepo: { findById: async () => appointment },
        jobRepo: { findById: async () => job },
        customerRepo: { findById: async () => customer },
        settingsRepo: { findByTenant: async () => ({ tenantId: TENANT, timezone: TZ }) } as never,
        auditRepo: { create: auditCreate } as never,
        enRouteCoordinator,
        now: () => NOW,
        ...overrides,
      };
      return { deps, enqueueEnRouteNotice, auditCreate };
    }

    it('fires triggerEnRoute for the acting user, speaks a confirmation, and mints nothing', async () => {
      const { deps, enqueueEnRouteNotice } = enRouteWorld();
      const adapter = makeAdapter({ classifier: CLASSIFIER, enRoute: deps });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn = await adapter.handleInput(sessionId, 'On my way to the Garcia job');

      // The shared act fired, scoped to THIS user's own assignments.
      expect(enqueueEnRouteNotice).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, appointmentId: APPT_GARCIA }),
      );
      expect(deps.assignmentRepo!.findByTechnician).toHaveBeenCalledWith(TENANT, USER_ROW_ID);

      // FSM untouched, nothing minted, no clarification card.
      expect(turn.state).toBe('intent_capture');
      expect(turn.proposalIds).toHaveLength(0);
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);

      // Spoken confirmation names the act AND keeps the core's own honest
      // sentence about the customer text.
      expect(turn.ttsText).toMatch(/en route/i);
      expect(turn.ttsText).toContain('Sent the customer an on-my-way text');
      expect(auditTypes()).toContain('agent.calling.en_route_executed');
    });

    it('speaks the honest "nothing to mark" answer when the operator has no visit today', async () => {
      const { deps, enqueueEnRouteNotice } = enRouteWorld({
        assignmentRepo: { findByTechnician: vi.fn(async () => []) },
      });
      const adapter = makeAdapter({ classifier: CLASSIFIER, enRoute: deps });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn = await adapter.handleInput(sessionId, 'On my way to the Garcia job');

      expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
      expect(turn.state).toBe('intent_capture');
      expect(turn.ttsText).toMatch(/don't have an upcoming appointment today/i);
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    });

    it('without the bundle it says so honestly — still never a voice_clarification card', async () => {
      const adapter = makeAdapter({ classifier: CLASSIFIER });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn = await adapter.handleInput(sessionId, 'On my way to the Garcia job');

      expect(turn.state).toBe('intent_capture');
      expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
      expect(turn.ttsText).toBe(INAPP_EN_ROUTE_UNAVAILABLE_LINE);
    });

    it('refuses to guess a day when the tenant has no timezone (Phoenix postmortem)', async () => {
      const { deps, enqueueEnRouteNotice } = enRouteWorld({
        settingsRepo: { findByTenant: async () => ({ tenantId: TENANT }) } as never,
      });
      const adapter = makeAdapter({ classifier: CLASSIFIER, enRoute: deps });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn = await adapter.handleInput(sessionId, 'On my way to the Garcia job');

      // "Today" is undefined without a zone, and a UTC fallback could text
      // TOMORROW's customer — so nothing is sent and the operator is told
      // exactly what to fix.
      expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
      expect(turn.ttsText).toBe(INAPP_EN_ROUTE_NO_TIMEZONE_LINE);
      expect(turn.state).toBe('intent_capture');
    });

    it('an account that matches no team member is an IDENTITY answer, not a silent act', async () => {
      const { deps, enqueueEnRouteNotice } = enRouteWorld({
        userRepo: { findByTenant: async () => [] },
      });
      const adapter = makeAdapter({ classifier: CLASSIFIER, enRoute: deps });
      const { sessionId } = await adapter.startSession(TENANT, USER, undefined, 'owner');

      const turn = await adapter.handleInput(sessionId, 'On my way to the Garcia job');

      expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
      expect(turn.state).toBe('intent_capture');
      expect(turn.ttsText).toBe(INAPP_NO_ACTOR_EN_ROUTE_LINE);
    });
  });
});
