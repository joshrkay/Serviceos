/**
 * VQ-004 — Observation builder tests.
 *
 * `buildObservation` is a pure function that synthesises the observation
 * record graders read after each scripted call. These tests drive emits
 * directly into a session's EventEmitter (the substrate the AgentEventBus
 * subscribes to) so we never have to spin up the full adapter stack.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { AgentEventBus } from '../../src/ai/voice-quality/event-bus';
import {
  intentClassifiedEvent,
  lookupExecutedEvent,
  costIncurredEvent,
  sessionTerminatedEvent,
} from '../../src/ai/voice-quality/events';
import { buildObservation } from '../../src/ai/voice-quality/observation';
import type { AuditEvent } from '../../src/audit/audit';
import type { VoiceSessionEvent } from '../../src/ai/agents/customer-calling/voice-session-store';

function makeStore(): VoiceSessionStore {
  return new VoiceSessionStore({ startInterval: false });
}

function emit(session: { events: { emit: (c: string, e: VoiceSessionEvent) => void } }, event: VoiceSessionEvent): void {
  session.events.emit('voice-event', event);
}

const baseInput = {
  callId: 'call-1',
  scriptId: 'happy-booker',
  tenantId: 't-1',
  proposalsAfter: [],
  customerCountBefore: 0,
  customerCountAfter: 0,
  appointmentCountBefore: 0,
  appointmentCountAfter: 0,
  audit: [] as AuditEvent[],
  callStartedAtMs: 1_000,
  callEndedAtMs: 5_000,
};

describe('VQ-004 — buildObservation', () => {
  let store: VoiceSessionStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('VQ-004 — buildObservation derives totalCostCents from cost_incurred events', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    emit(session, costIncurredEvent(3, 3, 1_100));
    emit(session, costIncurredEvent(5, 8, 1_200));
    emit(session, costIncurredEvent(2, 10, 1_300));

    const obs = buildObservation({ ...baseInput, bus });

    // The latest cost_incurred event carries the running total.
    expect(obs.totalCostCents).toBe(10);
  });

  it("VQ-004 — buildObservation marks sessionEndedAs 'terminated' when session_terminated cap_exceeded fires", () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    emit(session, sessionTerminatedEvent('cap_exceeded', 1_500));

    const obs = buildObservation({ ...baseInput, bus });

    expect(obs.sessionEndedAs).toBe('terminated');
    expect(obs.hangupOccurred).toBe(false);
  });

  it("VQ-004 — buildObservation marks sessionEndedAs 'completed' when session_terminated completed fires", () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    emit(session, sessionTerminatedEvent('completed', 1_500));

    const obs = buildObservation({ ...baseInput, bus });

    expect(obs.sessionEndedAs).toBe('completed');
    expect(obs.hangupOccurred).toBe(false);
  });

  it("VQ-004 — buildObservation marks hangupOccurred when session_terminated cause='hangup' fires", () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    emit(session, sessionTerminatedEvent('hangup', 1_500));

    const obs = buildObservation({ ...baseInput, bus });

    expect(obs.hangupOccurred).toBe(true);
    expect(obs.sessionEndedAs).toBe('terminated');
  });

  it('VQ-004 — buildObservation collects errors from failed lookup_executed events', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    emit(session, lookupExecutedEvent('lookup_customer', 12, true, undefined, 1_100));
    emit(session, lookupExecutedEvent('lookup_estimates', 9, false, 'db timeout', 1_200));
    emit(session, lookupExecutedEvent('lookup_appointments', 4, false, 'no rows', 1_300));

    const obs = buildObservation({ ...baseInput, bus });

    expect(obs.errors).toEqual([
      { event: 'lookup_estimates', message: 'db timeout' },
      { event: 'lookup_appointments', message: 'no rows' },
    ]);
  });

  it('VQ-004 — buildObservation computes customerCountDelta and appointmentCountDelta correctly (positive)', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    const obs = buildObservation({
      ...baseInput,
      bus,
      customerCountBefore: 4,
      customerCountAfter: 7,
      appointmentCountBefore: 10,
      appointmentCountAfter: 12,
    });

    expect(obs.customerCountDelta).toBe(3);
    expect(obs.appointmentCountDelta).toBe(2);
  });

  it('VQ-004 — buildObservation derives perTurnLatencyMs from intent_classified -> next lookup_executed deltas', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    emit(session, intentClassifiedEvent({ intentType: 'book', confidence: 0.9 }, 1_100));
    emit(session, intentClassifiedEvent({ intentType: 'confirm', confidence: 0.95 }, 1_400));
    emit(session, intentClassifiedEvent({ intentType: 'farewell', confidence: 0.99 }, 2_000));

    const obs = buildObservation({
      ...baseInput,
      bus,
      callEndedAtMs: 2_750,
    });

    // Three intent_classified events -> two pairwise deltas, then tail (callEnd - last).
    expect(obs.perTurnLatencyMs).toEqual([300, 600, 750]);
  });

  it('VQ-004 — buildObservation includes all events in chronological order', () => {
    const session = store.create('t-1', 'inapp');
    const bus = new AgentEventBus();
    bus.subscribe(session);

    const e1 = intentClassifiedEvent({ intentType: 'book', confidence: 0.9 }, 1_100);
    const e2 = lookupExecutedEvent('lookup_customer', 8, true, undefined, 1_200);
    const e3 = costIncurredEvent(2, 2, 1_300);
    const e4 = sessionTerminatedEvent('completed', 1_400);

    emit(session, e1);
    emit(session, e2);
    emit(session, e3);
    emit(session, e4);

    const obs = buildObservation({ ...baseInput, bus });

    expect(obs.events).toEqual([e1, e2, e3, e4]);
    // Defensive copy: mutating the returned array must not affect the bus.
    obs.events.push(sessionTerminatedEvent('completed', 9_999));
    expect(bus.events()).toHaveLength(4);
  });
});
