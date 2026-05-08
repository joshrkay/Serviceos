import { describe, it, expect } from 'vitest';
import { deriveCallOutcome } from '../../../../src/ai/agents/customer-calling/outcome-mapper';
import type { CallingAgentContext, CallingAgentState } from '../../../../src/ai/agents/customer-calling/types';

function ctx(overrides: Partial<CallingAgentContext> = {}): CallingAgentContext {
  return {
    sessionId: 's',
    tenantId: 't',
    channel: 'inapp',
    retryCount: 0,
    repromptCount: 0,
    startedAt: 0,
    ...overrides,
  };
}

const TERMINATED: CallingAgentState = 'terminated';
const ESCALATING: CallingAgentState = 'escalating';
const DEGRADED: CallingAgentState = 'degraded';

describe('deriveCallOutcome — caller_hangup paths', () => {
  it("dropped: caller never spoke", () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'caller_hangup',
        context: ctx(),
        transcript: ['agent: hello'],
        proposalIds: [],
      }),
    ).toBe('dropped');
  });

  it('no_intent: caller spoke but classifier never crossed TAU_INT', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'caller_hangup',
        context: ctx(),
        transcript: ['agent: hi', 'caller: uh'],
        proposalIds: [],
      }),
    ).toBe('no_intent');
  });

  it('completed: caller hangup after proposal queued', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'caller_hangup',
        context: ctx({ currentIntent: 'create_appointment' }),
        transcript: ['agent: hi', 'caller: book a tune-up'],
        proposalIds: ['p-1'],
      }),
    ).toBe('completed');
  });

  it('no_intent: intent set but no proposal yet', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'caller_hangup',
        context: ctx({ currentIntent: 'create_appointment' }),
        transcript: ['agent: hi', 'caller: maybe later'],
        proposalIds: [],
      }),
    ).toBe('no_intent');
  });
});

describe('deriveCallOutcome — normal_close / closed', () => {
  it('completed: proposal queued', () => {
    for (const reason of ['normal_close', 'closed'] as const) {
      expect(
        deriveCallOutcome({
          finalState: TERMINATED,
          endedReason: reason,
          context: ctx({ currentIntent: 'x' }),
          transcript: ['caller: yes'],
          proposalIds: ['p-1'],
        }),
      ).toBe('completed');
    }
  });

  it('completed: intent set even with no proposal (closing path always implies an intent confirmation)', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'normal_close',
        context: ctx({ currentIntent: 'create_appointment' }),
        transcript: ['caller: yes'],
        proposalIds: [],
      }),
    ).toBe('completed');
  });

  it('no_intent: spoke but no intent and no proposal', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'normal_close',
        context: ctx(),
        transcript: ['caller: hi'],
        proposalIds: [],
      }),
    ).toBe('no_intent');
  });

  it('dropped: never spoke and no proposal', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'normal_close',
        context: ctx(),
        transcript: ['agent: bye'],
        proposalIds: [],
      }),
    ).toBe('dropped');
  });
});

describe('deriveCallOutcome — session_ended / manual_end / idle_timeout', () => {
  it.each(['session_ended', 'manual_end', 'idle_timeout'])(
    'completed when proposal queued (reason=%s)',
    (reason) => {
      expect(
        deriveCallOutcome({
          finalState: TERMINATED,
          endedReason: reason,
          context: ctx({ currentIntent: 'x' }),
          transcript: ['caller: yes'],
          proposalIds: ['p-1'],
        }),
      ).toBe('completed');
    },
  );

  it('no_intent when caller spoke but no intent or proposal', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'session_ended',
        context: ctx(),
        transcript: ['caller: hello'],
        proposalIds: [],
      }),
    ).toBe('no_intent');
  });

  it('dropped when caller never spoke and no proposal', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'idle_timeout',
        context: ctx(),
        transcript: [],
        proposalIds: [],
      }),
    ).toBe('dropped');
  });
});

describe('deriveCallOutcome — abuse_detected', () => {
  it('escalated_to_human regardless of state or proposals', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'abuse_detected:profanity',
        context: ctx({ escalationReason: 'abuse_detected:profanity' }),
        transcript: ['caller: ...'],
        proposalIds: [],
      }),
    ).toBe('escalated_to_human');
  });
});

describe('deriveCallOutcome — escalating / degraded', () => {
  it('failed when escalationReason is system_failure:*', () => {
    expect(
      deriveCallOutcome({
        finalState: ESCALATING,
        endedReason: 'session_ended',
        context: ctx({ escalationReason: 'system_failure:proposal_create_threw' }),
        transcript: ['caller: hi'],
        proposalIds: [],
      }),
    ).toBe('failed');
  });

  it('callback_required when in escalating with a proposal queued (callback proposal)', () => {
    expect(
      deriveCallOutcome({
        finalState: ESCALATING,
        endedReason: 'session_ended',
        context: ctx({ escalationReason: 'cost_cap_exceeded' }),
        transcript: ['caller: hi'],
        proposalIds: ['p-callback'],
      }),
    ).toBe('callback_required');
  });

  it.each([
    'cost_cap_exceeded',
    'caller_identification_failed',
    'caller_identity_unresolved',
    'low_confidence_intent',
    'entity_not_found',
    'emergency_dispatch',
  ])('escalated_to_human for escalationReason=%s with no proposal', (reason) => {
    expect(
      deriveCallOutcome({
        finalState: ESCALATING,
        endedReason: 'session_ended',
        context: ctx({ escalationReason: reason }),
        transcript: ['caller: hi'],
        proposalIds: [],
      }),
    ).toBe('escalated_to_human');
  });

  it('escalated_to_human is the default when in escalating with unknown reason', () => {
    expect(
      deriveCallOutcome({
        finalState: ESCALATING,
        endedReason: 'session_ended',
        context: ctx({ escalationReason: 'something_else' }),
        transcript: [],
        proposalIds: [],
      }),
    ).toBe('escalated_to_human');
  });

  it('degraded state behaves like escalating', () => {
    expect(
      deriveCallOutcome({
        finalState: DEGRADED,
        endedReason: 'session_ended',
        context: ctx({ escalationReason: 'low_confidence_intent' }),
        transcript: ['caller: hi'],
        proposalIds: [],
      }),
    ).toBe('escalated_to_human');
  });
});

describe('deriveCallOutcome — defensive default', () => {
  it("returns 'failed' for unrecognised reason in terminated state", () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'something_unexpected',
        context: ctx(),
        transcript: [],
        proposalIds: [],
      }),
    ).toBe('failed');
  });
});

describe('deriveCallOutcome — callerSpoke detection', () => {
  it('case-insensitive prefix match', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'caller_hangup',
        context: ctx(),
        transcript: ['Caller: hello there'],
        proposalIds: [],
      }),
    ).toBe('no_intent');
  });

  it('non-prefixed lines do not count as caller speech', () => {
    expect(
      deriveCallOutcome({
        finalState: TERMINATED,
        endedReason: 'caller_hangup',
        context: ctx(),
        transcript: ['just some text', 'agent: hi'],
        proposalIds: [],
      }),
    ).toBe('dropped');
  });
});
