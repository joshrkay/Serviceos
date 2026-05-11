/**
 * P18-006 — Isolated voice flow tests for `reassign_appointment`.
 *
 * Drives the in-app voice adapter (and the underlying CallingAgentStateMachine
 * FSM) end-to-end with a scripted classifier so we can assert:
 *  - the FSM lands in the right state for each turn,
 *  - the proposal payload is correct (intent + entities including the
 *    target technician name),
 *  - audit transitions fire,
 *  - secondary paths (off-day target, non-existent user, ambiguous
 *    technician name, concurrent UI drag, audit scoping) all reach a
 *    sane terminal state instead of looping forever.
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

const TENANT = 'tenant-reassign';
const USER = 'user-reassign';

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

describe('P18-006 voice-reassign — reassign_appointment FSM voice flow', () => {
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

  // ── AC-1/2/3: full voice session → reassign_appointment proposal
  it('happy path: voice transcript drives FSM through entity_resolution → intent_confirm → proposal_draft → closing', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.94,
        extractedEntities: {
          appointmentReference: 'APT-0050',
          targetTechnicianName: 'Bob Sanchez',
          customerName: 'Acme Corp',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);

    const result = await adapter.handleInput(
      sessionId,
      'reassign the Acme Corp appointment to Bob Sanchez'
    );

    expect(result.state).toBe('closing');
    expect(result.proposalIds.length).toBe(1);

    // Proposal payload assertions.
    const [p] = await proposalRepo.findByTenant(TENANT);
    expect(p.proposalType).toBe('reassign_appointment');
    expect(p.payload).toMatchObject({
      intent: 'reassign_appointment',
      sessionId,
      entities: expect.objectContaining({
        appointmentReference: 'APT-0050',
        targetTechnicianName: 'Bob Sanchez',
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

  // Edge 1: tech is off the day of the appointment — proposal still queued
  // (conflict flag added by the review UI / approval gate, not the FSM).
  it('reassign to a tech who is off that day still drafts the proposal', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.9,
        extractedEntities: {
          appointmentReference: 'APT-OFF',
          targetTechnicianName: 'Carla on PTO',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      'give APT-OFF to Carla even though she is off'
    );
    expect(result.state).toBe('closing');
    const [p] = await proposalRepo.findByTenant(TENANT);
    expect(p.proposalType).toBe('reassign_appointment');
    expect((p.payload.entities as Record<string, unknown>).targetTechnicianName)
      .toBe('Carla on PTO');
  });

  // Edge 2: ambiguous target tech name → low confidence reprompt.
  it('voice transcript ambiguous about target tech → FSM stays in intent_capture', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({ intentType: 'unknown', confidence: 0.25 }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      'give APT-9 to one of the guys'
    );
    expect(result.state).toBe('intent_capture');
    expect(result.proposalIds.length).toBe(0);
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals.length).toBe(0);
  });

  // Edge 3: classifier returned a real intent but the targetTechnicianName
  // looks like nonsense ("Bob the imaginary"). FSM still drafts the
  // proposal — the review UI or execution handler resolves the name to a
  // user_id (or rejects if no match).
  it('reassign to a non-existent tech: FSM drafts proposal; review layer rejects', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.91,
        extractedEntities: {
          appointmentReference: 'APT-MISS',
          targetTechnicianName: 'Bob the imaginary',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    const result = await adapter.handleInput(
      sessionId,
      'reassign APT-MISS to Bob the imaginary'
    );
    expect(result.state).toBe('closing');
    const [p] = await proposalRepo.findByTenant(TENANT);
    expect(p.proposalType).toBe('reassign_appointment');
    // payload.entities must preserve the unresolved name so the review UI
    // can show "user not found — please pick a real tech".
    expect((p.payload.entities as Record<string, unknown>).targetTechnicianName)
      .toBe('Bob the imaginary');
  });

  // Edge 4: caller hangs up after starting reassign mid-flow.
  it('caller hangs up mid-reassign → FSM transitions to terminated', async () => {
    const fsm = new CallingAgentStateMachine({
      sessionId: 's-hangup-r',
      tenantId: TENANT,
      channel: 'inapp',
    });
    fsm.dispatch({
      type: 'session_started',
      tenantId: TENANT,
      userId: USER,
      conversationId: 's-hangup-r',
    });
    fsm.dispatch({ type: 'greeted_ok' });
    fsm.dispatch({ type: 'caller_known', customerId: USER });
    fsm.dispatch({
      type: 'intent_classified',
      intentType: 'reassign_appointment',
      entities: {
        appointmentReference: 'APT-0001',
        targetTechnicianName: 'Alice',
      },
      confidence: 0.92,
    });
    expect(fsm.currentState).toBe('entity_resolution');
    const effects = fsm.dispatch({ type: 'caller_hangup' });
    expect(fsm.currentState).toBe('terminated');
    expect(effects.some((e) => e.type === 'end_session')).toBe(true);
    expect(effects.some((e) => e.type === 'audit_log')).toBe(true);
  });

  // Edge 5: concurrent UI drag-drop while voice is mid-flow — both flows
  // produce independent proposals; queue-order is the approval winner.
  // Simulated by drafting two proposals against the same appointment.
  it('concurrent UI drag-drop and voice reassign both queue independent proposals', async () => {
    // Voice flow drafts a reassign proposal.
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.93,
        extractedEntities: {
          appointmentReference: 'APT-RACE',
          targetTechnicianName: 'Voice Tech',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    await adapter.handleInput(sessionId, 'reassign APT-RACE to Voice Tech');

    // Concurrent UI drag-drop persists a second proposal directly via repo.
    const { createProposal } = await import('../../../../src/proposals/proposal');
    const uiProposal = createProposal({
      tenantId: TENANT,
      proposalType: 'reassign_appointment',
      payload: {
        intent: 'reassign_appointment',
        entities: {
          appointmentReference: 'APT-RACE',
          targetTechnicianName: 'UI Tech',
        },
      },
      summary: 'Reassign APT-RACE to UI Tech',
      sourceContext: { source: 'ui-drag-drop' },
      createdBy: 'ui-user',
    });
    await proposalRepo.create(uiProposal);

    const proposals = await proposalRepo.findByTenant(TENANT);
    const reassigns = proposals.filter((p) => p.proposalType === 'reassign_appointment');
    expect(reassigns.length).toBe(2);
    const targets = reassigns.map(
      (p) => (p.payload.entities as Record<string, unknown>).targetTechnicianName
    );
    expect(targets).toEqual(expect.arrayContaining(['Voice Tech', 'UI Tech']));
  });

  // Edge 6: tenant isolation — reassign proposals stay scoped to the tenant
  // that the voice session belongs to.
  it('tenant isolation: reassign proposals scoped to caller tenant only', async () => {
    const gatewayA = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.92,
        extractedEntities: {
          appointmentReference: 'APT-A',
          targetTechnicianName: 'Tech A',
        },
      }),
    ]);
    const gatewayB = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.92,
        extractedEntities: {
          appointmentReference: 'APT-B',
          targetTechnicianName: 'Tech B',
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
    await adapterA.handleInput(sa, 'reassign APT-A to Tech A');
    await adapterB.handleInput(sb, 'reassign APT-B to Tech B');

    const propsA = await proposalRepo.findByTenant('tenant-A');
    const propsB = await proposalRepo.findByTenant('tenant-B');
    expect(propsA.length).toBe(1);
    expect(propsB.length).toBe(1);
    expect(propsA[0].tenantId).toBe('tenant-A');
    expect(propsB[0].tenantId).toBe('tenant-B');
  });

  // Edge 7: audit captures originating session id and tenant for the
  // reassign transitions.
  it('audit captures originating session id on reassign transitions', async () => {
    const gateway = scriptedGateway([
      JSON.stringify({
        intentType: 'reassign_appointment',
        confidence: 0.93,
        extractedEntities: {
          appointmentReference: 'APT-AUD2',
          targetTechnicianName: 'Audit Tech',
        },
      }),
    ]);
    const adapter = makeAdapter(gateway);
    const { sessionId } = await adapter.startSession(TENANT, USER);
    await adapter.handleInput(sessionId, 'reassign APT-AUD2 to Audit Tech');

    const audits = auditRepo
      .getAll()
      .filter((e) => e.entityType === 'voice_session' && e.entityId === sessionId);
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(a.correlationId).toBe(sessionId);
      expect(a.tenantId).toBe(TENANT);
    }
  });
});
