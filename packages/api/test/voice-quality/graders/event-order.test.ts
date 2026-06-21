/**
 * Tests for the shared causal-ordering helper used by the floor and
 * disposition-structured graders. The point of the helper is that event
 * `ts` (Date.now() ms) ties on sub-millisecond scripts, so graders order
 * by append-only log position instead.
 */
import { describe, it, expect } from 'vitest';
import { eventLogIndex } from '../../../src/ai/voice-quality/graders/event-order';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';

function intent(intentType: string, ts: number): VoiceSessionEvent {
  return {
    type: 'intent_classified',
    intentType,
    confidence: 0.9,
    tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    ts,
  };
}

function escalation(ts: number): VoiceSessionEvent {
  return { type: 'escalation_triggered', reason: 'r', ts };
}

describe('eventLogIndex', () => {
  it("returns each event's position in the append-only log", () => {
    const a = intent('a', 1_000);
    const b = intent('b', 1_000);
    const c = escalation(1_000);
    const at = eventLogIndex([a, b, c]);
    expect(at(a)).toBe(0);
    expect(at(b)).toBe(1);
    expect(at(c)).toBe(2);
  });

  it('breaks identical timestamps by causal log order (the tie the graders rely on)', () => {
    const earlier = intent('a', 5_000);
    const later = escalation(5_000); // same ts, later in the log
    const at = eventLogIndex([earlier, later]);
    expect(at(later)).toBeGreaterThan(at(earlier));
  });

  it('maps an event absent from the log to -1 (sorts before every real event)', () => {
    const known = intent('a', 1_000);
    const stranger = escalation(1_000);
    const at = eventLogIndex([known]);
    expect(at(known)).toBe(0);
    expect(at(stranger)).toBe(-1);
  });
});
