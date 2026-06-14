/**
 * P12-004 wiring — emergency-intent immediate Dial in the voice-turn
 * processor.
 *
 * When the classifier returns an emergency intent AND the tenant is
 * unsupervised, the processor bypasses the FSM/booking path and dials the
 * on-call rotation immediately via `emergencyImmediateDial` (which routes
 * through the existing `escalateToHuman` skill). Supervised tenants keep
 * the normal path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryOnCallRepository } from '../../../src/oncall/rotation';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../../src/ai/supervisor-presence';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function makeGatewayReturning(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return {
    complete: vi.fn().mockResolvedValue(response),
  } as unknown as LLMGateway;
}

function makeCtx(opts: { supervisorPresent: boolean }) {
  setSupervisorPresenceLoader(async () => opts.supervisorPresent);

  const store = new VoiceSessionStore({ startInterval: false });
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const onCallRepo = new InMemoryOnCallRepository(
    new Map([
      ['tenant-abc', [{ id: 'rot-1', userId: 'u-dispatcher', orderIndex: 0 }]],
    ]),
  );

  const session = store.create('tenant-abc', 'telephony', { callSid: 'CA-test' });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: 'CA-test',
    from: '+15125550100',
    to: '+15125550999',
    tenantId: 'tenant-abc',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  session.customerId = 'cust-1';

  const gateway = makeGatewayReturning(
    JSON.stringify({
      intentType: 'emergency_dispatch',
      confidence: 0.96,
      reasoning: 'caller reports burst pipe flooding the basement',
      extractedEntities: { description: 'burst pipe' },
    }),
  );

  const processor = createVoiceTurnProcessor({
    store,
    gateway,
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo,
    proposalRepo,
    onCallRepo,
    dispatcherPhoneResolver: async () => '+15125550111',
  });

  return { processor, session, auditRepo };
}

afterEach(() => {
  _resetSupervisorPresenceCache();
  setSupervisorPresenceLoader(null);
});

describe('voice-turn processor — emergency immediate Dial (P12-004)', () => {
  it('unsupervised + emergency intent: dials immediately and emits emergency_immediate_dial audit', async () => {
    const { processor, session, auditRepo } = makeCtx({ supervisorPresent: false });

    const sideEffects = await processor.speechTurn({
      session,
      speechResult: 'There is a burst pipe flooding my basement right now',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const events = auditRepo.getAll();
    const dialEvent = events.find((e) => e.eventType === 'emergency_immediate_dial');
    expect(dialEvent).toBeDefined();
    expect(dialEvent?.metadata).toMatchObject({
      intent: 'emergency_dispatch',
      channel: 'telephony',
      escalated: true,
    });

    // The existing escalation path ran (rotation walked, transfer initiated).
    const escalation = events.find((e) => e.eventType === 'escalation.requested');
    expect(escalation?.metadata).toMatchObject({
      reason: 'emergency_dispatch',
      outcome: 'transfer_initiated',
      assignedUserId: 'u-dispatcher',
    });

    // The caller hears the emergency message; the booking FSM was bypassed
    // (no intent_confirm advance).
    const tts = sideEffects.find((fx) => fx.type === 'tts_play');
    expect(tts && String(tts.payload.text)).toContain('Emergency escalation in progress');
    expect(session.machine.currentState).not.toBe('intent_confirm');
  });

  it('supervised tenant: emergency intent takes the normal FSM path (no immediate dial)', async () => {
    const { processor, session, auditRepo } = makeCtx({ supervisorPresent: true });

    await processor.speechTurn({
      session,
      speechResult: 'There is a burst pipe flooding my basement right now',
      callSid: 'CA-test',
      tenantId: 'tenant-abc',
    });

    const events = auditRepo.getAll();
    expect(events.find((e) => e.eventType === 'emergency_immediate_dial')).toBeUndefined();
  });
});
