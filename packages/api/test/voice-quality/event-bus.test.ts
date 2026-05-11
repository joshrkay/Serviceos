/**
 * VQ-003 — AgentEventBus tests.
 *
 * The AgentEventBus is a thin facade over `VoiceSession.events` that
 * subscribes to the existing 'voice-event' channel and accumulates a
 * unified observation log across one-or-more sessions. Used by the
 * Voice Quality harness to assert side effects without reaching into
 * adapter internals.
 *
 * These tests drive emits directly on `session.events` (and through the
 * lightweight emit helpers) rather than through the full adapter so the
 * unit boundary stays small and existing voice/twilio tests are
 * untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import {
  intentClassifiedEvent,
  lookupExecutedEvent,
  escalationTriggeredEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
  speechOutboundEvent,
} from '../../src/ai/voice-quality/events';
import { escalateToHuman } from '../../src/ai/skills/escalate-to-human';
import { SessionCostTracker } from '../../src/ai/skills/session-cost-tracker';
import type { OnCallRepository, OnCallEntry } from '../../src/oncall/rotation';

function makeStore(): VoiceSessionStore {
  return new VoiceSessionStore({ startInterval: false });
}

describe('VQ-003 — AgentEventBus', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('VQ-003 — bus captures intent_classified after classifier returns', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    const event = intentClassifiedEvent({
      intentType: 'create_invoice',
      confidence: 0.92,
      tokenUsage: { input: 120, output: 30 },
    });
    session.events.emit('voice-event', event);

    const captured = bus.filterByType('intent_classified');
    expect(captured).toHaveLength(1);
    expect(captured[0].intentType).toBe('create_invoice');
    expect(captured[0].confidence).toBeCloseTo(0.92);
    expect(captured[0].tokenUsage.inputTokens).toBe(120);
    expect(captured[0].tokenUsage.outputTokens).toBe(30);
    expect(captured[0].tokenUsage.costCents).toBeGreaterThanOrEqual(0);
    expect(typeof captured[0].ts).toBe('number');

    store.dispose();
  });

  it('VQ-003 — bus captures lookup_executed after a lookup skill runs', () => {
    const session = store.create('t-1', 'telephony', { callSid: 'CA-1' });
    const bus = new AgentEventBus();
    bus.subscribe(session);

    session.events.emit(
      'voice-event',
      lookupExecutedEvent('lookup_appointments', 42, true),
    );
    session.events.emit(
      'voice-event',
      lookupExecutedEvent('lookup_invoices', 15, false, 'no customer linked'),
    );

    const captured = bus.filterByType('lookup_executed');
    expect(captured).toHaveLength(2);
    expect(captured[0].skillName).toBe('lookup_appointments');
    expect(captured[0].durationMs).toBe(42);
    expect(captured[0].success).toBe(true);
    expect(captured[1].success).toBe(false);
    expect(captured[1].error).toBe('no customer linked');

    store.dispose();
  });

  it('VQ-003 — bus captures proposal_created after action-router handles a mutation intent', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    // The inapp-adapter and twilio-adapter both emit `proposal_created`
    // on session.events when a proposal is persisted (line ~497 in
    // inapp-adapter today). Simulate that emission directly so we
    // assert the bus's observation behavior, not the adapter wiring.
    session.events.emit('voice-event', {
      type: 'proposal_created',
      proposalId: 'prop-abc-123',
    });

    const captured = bus.filterByType('proposal_created');
    expect(captured).toHaveLength(1);
    expect(captured[0].proposalId).toBe('prop-abc-123');

    store.dispose();
  });

  it('VQ-003 — bus captures escalation_triggered after escalate-to-human runs', async () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    const onCallRepo: OnCallRepository = {
      async getNextOnCall(): Promise<OnCallEntry | null> {
        return {
          id: 'rot-1',
          userId: 'user-disp-1',
          orderIndex: 0,
        };
      },
      async listRotation(): Promise<OnCallEntry[]> {
        return [];
      },
    };

    const result = await escalateToHuman({
      tenantId: 't-1',
      sessionId: session.id,
      reason: 'caller_requested',
      channel: 'inapp',
      onCallRepo,
      session,
    });

    expect(result.escalated).toBe(true);

    const captured = bus.filterByType('escalation_triggered');
    expect(captured).toHaveLength(1);
    expect(captured[0].reason).toBe('caller_requested');

    store.dispose();
  });

  it('VQ-003 — bus captures cost_incurred after cost tracker records usage', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    const tracker = new SessionCostTracker();
    tracker.recordUsage({ inputTokens: 100, outputTokens: 50, costCents: 5 });
    session.events.emit('voice-event', costIncurredEvent(5, tracker.totals.costCents));

    tracker.recordUsage({ inputTokens: 200, outputTokens: 80, costCents: 7 });
    session.events.emit('voice-event', costIncurredEvent(7, tracker.totals.costCents));

    const captured = bus.filterByType('cost_incurred');
    expect(captured).toHaveLength(2);
    expect(captured[0].deltaCents).toBe(5);
    expect(captured[0].totalCents).toBe(5);
    expect(captured[1].deltaCents).toBe(7);
    expect(captured[1].totalCents).toBe(12);

    store.dispose();
  });

  it('VQ-003 — bus events include monotonic ts (each ts >= previous)', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    // Emit a stream of events back-to-back. ts is Date.now() at the
    // emit site, so on any reasonable machine each successive event's
    // ts must be >= the previous event's ts.
    session.events.emit('voice-event', intentClassifiedEvent({
      intentType: 'create_invoice',
      confidence: 0.9,
      tokenUsage: { input: 10, output: 5 },
    }));
    session.events.emit('voice-event', lookupExecutedEvent('lookup_invoices', 1, true));
    session.events.emit('voice-event', costIncurredEvent(3, 3));
    session.events.emit('voice-event', escalationTriggeredEvent('low_confidence'));
    session.events.emit('voice-event', sessionTerminatedEvent('completed'));

    const events = bus.events();
    expect(events.length).toBe(5);
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      // Existing union variants ('proposal_created', 'transition',
      // 'ended') don't carry ts; the new variants we added all do.
      // Filter to ts-bearing events for monotonicity assertion.
      if ('ts' in prev && 'ts' in curr && typeof prev.ts === 'number' && typeof curr.ts === 'number') {
        expect(curr.ts).toBeGreaterThanOrEqual(prev.ts);
      }
    }

    store.dispose();
  });

  it('VQ-003 — bus.clear() resets state', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    session.events.emit('voice-event', costIncurredEvent(1, 1));
    session.events.emit('voice-event', costIncurredEvent(2, 3));
    expect(bus.events()).toHaveLength(2);

    bus.clear();
    expect(bus.events()).toHaveLength(0);

    // Bus stays subscribed after clear — new emits still land.
    session.events.emit('voice-event', costIncurredEvent(4, 7));
    expect(bus.events()).toHaveLength(1);

    store.dispose();
  });

  it('VQ2-followup — bus captures speech_outbound events emitted on the session', () => {
    const session = store.create('t-1', 'telephony', { callSid: 'CA-spk-1' });
    const bus = new AgentEventBus();
    bus.subscribe(session);

    session.events.emit(
      'voice-event',
      speechOutboundEvent({ transcript: 'first reply', turnIndex: 0 }),
    );
    session.events.emit(
      'voice-event',
      speechOutboundEvent({ transcript: 'second reply', turnIndex: 1 }),
    );

    const captured = bus.filterByType('speech_outbound');
    expect(captured).toHaveLength(2);
    expect(captured[0].transcript).toBe('first reply');
    expect(captured[0].turnIndex).toBe(0);
    expect(captured[1].transcript).toBe('second reply');
    expect(captured[1].turnIndex).toBe(1);
    for (const e of captured) {
      expect(typeof e.ts).toBe('number');
    }

    store.dispose();
  });

  it('VQ2-followup — bus.record() appends a synthesized speech_outbound (matches AudioModeDriver emit path)', () => {
    const session = store.create('t-1', 'telephony', { callSid: 'CA-spk-2' });
    const bus = new AgentEventBus();
    bus.subscribe(session);

    // AudioModeDriver uses bus.record() (direct append) rather than
    // emitting through session.events. Confirm the bus surfaces those
    // events in the unified observation log just like subscribed emits.
    bus.record(speechOutboundEvent({ transcript: 'recorded directly', turnIndex: 0 }));

    const captured = bus.filterByType('speech_outbound');
    expect(captured).toHaveLength(1);
    expect(captured[0].transcript).toBe('recorded directly');
    expect(captured[0].turnIndex).toBe(0);

    store.dispose();
  });

  it('VQ-003 — multiple sessions on one bus capture interleaved events correctly', () => {
    const sessionA = store.create('t-1', 'inapp');
    const sessionB = store.create('t-2', 'telephony', { callSid: 'CA-XYZ' });

    const bus = new AgentEventBus();
    bus.subscribe(sessionA);
    bus.subscribe(sessionB);

    sessionA.events.emit('voice-event', intentClassifiedEvent({
      intentType: 'create_invoice',
      confidence: 0.91,
      tokenUsage: { input: 10, output: 5 },
    }));
    sessionB.events.emit('voice-event', lookupExecutedEvent('lookup_balance', 12, true));
    sessionA.events.emit('voice-event', costIncurredEvent(2, 2));
    sessionB.events.emit('voice-event', escalationTriggeredEvent('emergency_dispatch'));

    const events = bus.events();
    expect(events.length).toBe(4);
    expect(events[0].type).toBe('intent_classified');
    expect(events[1].type).toBe('lookup_executed');
    expect(events[2].type).toBe('cost_incurred');
    expect(events[3].type).toBe('escalation_triggered');

    store.dispose();
  });
});
