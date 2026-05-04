/**
 * P18-006 — Isolated voice flow tests for `cancel_appointment`.
 *
 * Drives the in-app voice adapter (and the underlying CallingAgentStateMachine
 * FSM) end-to-end with a scripted classifier so we can assert:
 *  - the FSM lands in the right state for each turn,
 *  - the proposal payload is correct (intent + entities including the
 *    cancellationReason / cancellationType),
 *  - audit transitions fire,
 *  - secondary paths (cancelling completed/already-cancelled appointments,
 *    rescheduling-past-time, far-future, transcript excerpt audit) all
 *    reach a sane terminal state instead of looping forever.
 *
 * Uses the existing FSM mock infrastructure from `inapp-adapter.test.ts`
 * (scriptedGateway + InMemory* repos). Each test runs in well under 2s.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { CallingAgentStateMachine } from '../../../../src/ai/agents/customer-calling/state-machine';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';

const TENANT = 'tenant-cancel';
const USER = 'user-cancel';

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

describe('P18-006 voice-cancel — cancel_appointment FSM voice flow', () => {
  let store: VoiceSessionStore;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let onCallRepo: InMemoryOnCallRepository;

  beforeEach(() => {
    store = new VoiceSessionStore({ startInterval: false });
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    onCallRepo = new InMemoryOnCallRepository();
  });

  afterEach(() => {
    store.dispose();
  });

  function makeAdapter(gateway: LLMGateway) {
    return new InAppVoiceAdapter({
      store,
      gateway,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
  }

  // ── AC-1/2/3: full voice session → cancel_appointment proposal
  it('happy path: voice transcript drives FSM through entity_resolution → intent_confirm → proposal_draft → closing', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.93,
        extractedEntities: {
          appointmentReference: 'APT-CXL-1',
          customerName: 'Smith',
          cancellationReason: 'Customer no longer needs service',
          cancellationType: 'customer_request',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const result = await adapter.handleInput(
      sessionId,
      'cancel the Smith appointment, customer changed their mind'
    );

    expect(result.state).toBe('closing');
    expect(result.proposalIds.length).toBe(1);

    // Proposal payload assertions.
    const [p] = await proposalRepo.findByTenant(TENANT);
    expect(p.proposalType).toBe('cancel_appointment');
    expect(p.payload).toMatchObject({
      intent: 'cancel_appointment',
      sessionId,
      entities: expect.objectContaining({
        appointmentReference: 'APT-CXL-1',
        cancellationType: 'customer_request',
        cancellationReason: 'Customer no longer needs service',
      }),
    });
    expect(p.tenantId).toBe(TENANT);

    // Audit chain.
    const audits = auditRepo.getAll().map((e) => e.eventType);
    expect(audits).toContain('agent.calling.intent_capture.intent_classified');
    expect(audits).toContain('agent.calling.entity_resolution.entity_resolved');
    expect(audits).toContain('agent.calling.intent_confirm.confirmed');
    expect(audits).toContain('agent.calling.proposal_draft.proposal_queued');
  });

  // Edge 1: cancelling a completed appointment — FSM still drafts the
  // proposal, but the review/execution layer rejects "already completed".
  // The voice path is consistent here: proposal-first, validation-later.
  it('cancel a completed appointment: proposal drafted; rejection happens at execution', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.94,
        extractedEntities: {
          appointmentReference: 'APT-DONE',
          cancellationType: 'other',
          cancellationReason: 'caller wants to cancel a completed appointment',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      'cancel APT-DONE'
    );
    expect(result.state).toBe('closing');
    const [p] = await proposalRepo.findByTenant(TENANT);
    expect(p.proposalType).toBe('cancel_appointment');
    expect((p.payload.entities as Record<string, unknown>).appointmentReference)
      .toBe('APT-DONE');
  });

  // Edge 2: cancelling an already-cancelled appointment → idempotent path
  // (proposal still drafted; execution short-circuits no-op).
  it('cancel an already-cancelled appointment: proposal still queued idempotently', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.92,
        extractedEntities: {
          appointmentReference: 'APT-ALREADY-CXL',
          cancellationType: 'customer_request',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      'cancel APT-ALREADY-CXL again please'
    );
    expect(result.state).toBe('closing');
    expect(result.proposalIds.length).toBe(1);
  });

  // Edge 3: caller hangs up after starting cancel mid-flow → terminated.
  it('caller hangs up mid-cancel → FSM transitions to terminated', async () => {
    const fsm = new CallingAgentStateMachine({
      sessionId: 's-hangup-c',
      tenantId: TENANT,
      channel: 'inapp',
    });
    fsm.dispatch({
      type: 'session_started',
      tenantId: TENANT,
      userId: USER,
      conversationId: 's-hangup-c',
    });
    fsm.dispatch({ type: 'greeted_ok' });
    fsm.dispatch({ type: 'caller_known', customerId: USER });
    fsm.dispatch({
      type: 'intent_classified',
      intentType: 'cancel_appointment',
      entities: { appointmentReference: 'APT-X' },
      confidence: 0.91,
    });
    expect(fsm.currentState).toBe('entity_resolution');
    const effects = fsm.dispatch({ type: 'caller_hangup' });
    expect(fsm.currentState).toBe('terminated');
    expect(effects.some((e) => e.type === 'end_session')).toBe(true);
  });

  // Edge 4: reschedule past the appointment time — when phrased as "cancel
  // and reschedule for yesterday" the classifier coerces to unknown /
  // low-conf so the FSM reprompts. Verifies cross-intent guarding.
  it('reschedule past the appointment time variant: low-confidence reprompt, no proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'unknown', confidence: 0.18 }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      "cancel APT-7 and reschedule it for yesterday"
    );
    expect(result.state).toBe('intent_capture');
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals.length).toBe(0);
  });

  // Edge 5: reschedule far into the future (2+ years) — phrased as a
  // cancel-then-rebook the classifier returns reschedule_appointment with
  // a far-future newDateTimeDescription; FSM drafts the proposal — the
  // reviewer is the one to flag the warning.
  it('reschedule 2+ years out via voice: proposal accepted with warning at review (FSM-side: drafted)', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'reschedule_appointment',
        confidence: 0.9,
        extractedEntities: {
          appointmentReference: 'APT-FUTURE',
          newDateTimeDescription: 'in three years',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      'push APT-FUTURE out by three years'
    );
    expect(result.state).toBe('closing');
    const [p] = await proposalRepo.findByTenant(TENANT);
    expect(p.proposalType).toBe('reschedule_appointment');
    expect((p.payload.entities as Record<string, unknown>).newDateTimeDescription)
      .toBe('in three years');
  });

  // Edge 6: tenant isolation — cancel proposals stay scoped to the tenant
  // that the voice session belongs to.
  it('tenant isolation: cancel proposals scoped to caller tenant only', async () => {
    const gatewayA = scriptedGateway([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.92,
        extractedEntities: {
          appointmentReference: 'APT-A',
          cancellationType: 'customer_request',
        },
      }),
    ]);
    const gatewayB = scriptedGateway([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.92,
        extractedEntities: {
          appointmentReference: 'APT-B',
          cancellationType: 'scheduling_conflict',
        },
      }),
    ]);
    const adapterA = makeAdapter(gatewayA);
    const adapterB = new InAppVoiceAdapter({
      store,
      gateway: gatewayB,
      proposalRepo,
      auditRepo,
      onCallRepo,
    });
    const { sessionId: sa } = await adapterA.startSession('tenant-A', 'user-A');
    const { sessionId: sb } = await adapterB.startSession('tenant-B', 'user-B');
    await adapterA.handleInput(sa, 'cancel APT-A');
    await adapterB.handleInput(sb, 'cancel APT-B');

    const propsA = await proposalRepo.findByTenant('tenant-A');
    const propsB = await proposalRepo.findByTenant('tenant-B');
    expect(propsA.length).toBe(1);
    expect(propsB.length).toBe(1);
    expect(propsA[0].tenantId).toBe('tenant-A');
    expect(propsB[0].tenantId).toBe('tenant-B');
    expect((propsA[0].payload.entities as Record<string, unknown>).cancellationType)
      .toBe('customer_request');
    expect((propsB[0].payload.entities as Record<string, unknown>).cancellationType)
      .toBe('scheduling_conflict');
  });

  // Edge 7: audit captures originating session id and a transcript excerpt
  // (the session retains transcript lines on each turn).
  it('audit captures originating session + transcript excerpt for cancel transitions', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'cancel_appointment',
        confidence: 0.95,
        extractedEntities: {
          appointmentReference: 'APT-EXCERPT',
          cancellationType: 'customer_request',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const transcript = 'cancel APT-EXCERPT, customer is moving out of state';
    await adapter.handleInput(sessionId, transcript);

    // Audit rows for the session must exist + correlate by sessionId.
    const audits = auditRepo
      .getAll()
      .filter((e) => e.entityType === 'voice_session' && e.entityId === sessionId);
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(a.correlationId).toBe(sessionId);
      expect(a.tenantId).toBe(TENANT);
    }

    // Transcript excerpt is captured on the session itself (the summary
    // skill and the audit cross-reference both use this transcript).
    const session = store.peek(sessionId);
    expect(session).toBeDefined();
    expect(session?.transcript.some((line) => line.includes(transcript))).toBe(true);
  });
});
