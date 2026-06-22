import { describe, it, expect } from 'vitest';
import {
  computeVoiceRoi,
  RepoBackedVoiceRoiReporter,
  type VoiceRoiInput,
  type VoiceRoiSession,
} from '../../src/analytics/voice-roi';
import type { BusinessHoursConfig } from '../../src/compliance/business-hours';
import type {
  Proposal,
  ProposalType,
  ProposalStatus,
  ProposalRepository,
} from '../../src/proposals/proposal';

const WINDOW_START = new Date('2026-06-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-06-08T00:00:00.000Z');

// Mon–Fri 09:00–17:00 in UTC. Used so after-hours math is deterministic.
const BUSINESS_HOURS: BusinessHoursConfig = {
  timezone: 'UTC',
  schedule: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    openTime: '09:00',
    closeTime: '17:00',
  })),
};

function session(over: Partial<VoiceRoiSession>): VoiceRoiSession {
  return {
    channel: 'voice_inbound',
    startedAt: new Date('2026-06-02T10:00:00.000Z'), // Tue, business hours
    endedAt: new Date('2026-06-02T10:05:00.000Z'),
    outcome: 'completed',
    ...over,
  };
}

function proposal(over: {
  proposalType: ProposalType;
  status?: ProposalStatus;
  executedAt?: Date;
  updatedAt?: Date;
}): Proposal {
  const now = new Date('2026-06-03T12:00:00.000Z');
  return {
    id: `prop-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    proposalType: over.proposalType,
    status: over.status ?? 'executed',
    payload: {},
    summary: 's',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: over.updatedAt ?? now,
    executedAt: over.executedAt ?? now,
  };
}

const base: Omit<VoiceRoiInput, 'sessions' | 'proposals'> = {
  businessHours: BUSINESS_HOURS,
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
};

describe('computeVoiceRoi', () => {
  it('counts inbound calls only on the inbound channel within the window', () => {
    const summary = computeVoiceRoi({
      ...base,
      sessions: [
        session({}),
        session({ channel: 'voice_outbound' }), // not inbound
        session({ channel: 'sms' }), // not inbound
        session({ startedAt: new Date('2026-05-30T10:00:00.000Z') }), // before window
        session({ startedAt: new Date('2026-06-09T10:00:00.000Z') }), // after window
      ],
      proposals: [],
    });
    expect(summary.inboundCalls).toBe(1);
  });

  it('treats a call as answered when it ended and did not fail', () => {
    const summary = computeVoiceRoi({
      ...base,
      sessions: [
        session({ outcome: 'completed' }),
        session({ outcome: 'escalated_to_human' }),
        session({ outcome: 'dropped' }), // caller hung up — still answered
        session({ outcome: 'failed' }), // system failure — NOT answered
        session({ endedAt: undefined, outcome: undefined }), // still open — NOT answered
      ],
      proposals: [],
    });
    expect(summary.inboundCalls).toBe(5);
    expect(summary.answeredCalls).toBe(3);
    expect(summary.answerRate).toBe(0.6);
  });

  it('counts only executed booking proposals inside the window as booked', () => {
    const summary = computeVoiceRoi({
      ...base,
      sessions: [],
      proposals: [
        proposal({ proposalType: 'create_appointment' }),
        proposal({ proposalType: 'create_booking' }),
        proposal({ proposalType: 'create_booking', status: 'rejected' }), // not executed
        proposal({ proposalType: 'draft_estimate' }), // not a booking type
        proposal({
          proposalType: 'create_appointment',
          executedAt: new Date('2026-05-20T12:00:00.000Z'), // before window
        }),
      ],
    });
    expect(summary.bookedByAgent).toBe(2);
  });

  it('counts after-hours captures for answered calls outside business hours', () => {
    const summary = computeVoiceRoi({
      ...base,
      sessions: [
        session({
          startedAt: new Date('2026-06-02T20:00:00.000Z'), // Tue 8pm — after hours
          endedAt: new Date('2026-06-02T20:05:00.000Z'),
        }),
        session({
          startedAt: new Date('2026-06-06T11:00:00.000Z'), // Sat — closed
          endedAt: new Date('2026-06-06T11:05:00.000Z'),
        }),
        session({}), // Tue 10am — within hours
        session({
          startedAt: new Date('2026-06-02T21:00:00.000Z'), // after hours but FAILED
          endedAt: new Date('2026-06-02T21:01:00.000Z'),
          outcome: 'failed',
        }),
      ],
      proposals: [],
    });
    expect(summary.afterHoursCaptures).toBe(2);
  });

  it('wouldHaveHitVoicemail unions after-hours and line-busy (overlapping) captures', () => {
    const summary = computeVoiceRoi({
      ...base,
      sessions: [
        // Two overlapping in-hours calls — the second would have hit voicemail.
        session({
          startedAt: new Date('2026-06-02T10:00:00.000Z'),
          endedAt: new Date('2026-06-02T10:10:00.000Z'),
        }),
        session({
          startedAt: new Date('2026-06-02T10:05:00.000Z'),
          endedAt: new Date('2026-06-02T10:12:00.000Z'),
        }),
        // One after-hours call — also would have hit voicemail.
        session({
          startedAt: new Date('2026-06-02T22:00:00.000Z'),
          endedAt: new Date('2026-06-02T22:05:00.000Z'),
        }),
      ],
      proposals: [],
    });
    expect(summary.afterHoursCaptures).toBe(1);
    // both overlapping calls (2) + the after-hours call (1) = 3
    expect(summary.wouldHaveHitVoicemail).toBe(3);
    expect(summary.wouldHaveHitVoicemail).toBeGreaterThanOrEqual(summary.afterHoursCaptures);
  });

  it('does not double-count an after-hours call that also overlaps', () => {
    const summary = computeVoiceRoi({
      ...base,
      sessions: [
        session({
          startedAt: new Date('2026-06-02T22:00:00.000Z'),
          endedAt: new Date('2026-06-02T22:10:00.000Z'),
        }),
        session({
          startedAt: new Date('2026-06-02T22:05:00.000Z'),
          endedAt: new Date('2026-06-02T22:12:00.000Z'),
        }),
      ],
      proposals: [],
    });
    expect(summary.afterHoursCaptures).toBe(2);
    expect(summary.wouldHaveHitVoicemail).toBe(2); // both, counted once each
  });

  it('with no business hours configured, attributes no after-hours captures', () => {
    const summary = computeVoiceRoi({
      ...base,
      businessHours: null,
      sessions: [
        session({ startedAt: new Date('2026-06-02T03:00:00.000Z'), endedAt: new Date('2026-06-02T03:05:00.000Z') }),
      ],
      proposals: [],
    });
    expect(summary.inboundCalls).toBe(1);
    expect(summary.afterHoursCaptures).toBe(0);
    expect(summary.wouldHaveHitVoicemail).toBe(0);
  });

  it('returns zeros and a 0 answerRate for an empty tenant', () => {
    const summary = computeVoiceRoi({ ...base, sessions: [], proposals: [] });
    expect(summary).toMatchObject({
      inboundCalls: 0,
      answeredCalls: 0,
      bookedByAgent: 0,
      afterHoursCaptures: 0,
      wouldHaveHitVoicemail: 0,
      answerRate: 0,
    });
    expect(summary.windowStart).toBe(WINDOW_START.toISOString());
    expect(summary.windowEnd).toBe(WINDOW_END.toISOString());
  });
});

describe('RepoBackedVoiceRoiReporter', () => {
  it('composes repos over a rolling window and passes business hours through', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z');
    const inboundAfterHours = session({
      startedAt: new Date('2026-06-07T23:00:00.000Z'), // Sun — closed
      endedAt: new Date('2026-06-07T23:05:00.000Z'),
    });
    const tooOld = session({
      startedAt: new Date('2026-04-01T10:00:00.000Z'), // > 30d before now
      endedAt: new Date('2026-04-01T10:05:00.000Z'),
    });

    const voiceSessionRepo = {
      findByTenant: async (tenantId: string, opts?: { limit?: number }) => {
        expect(tenantId).toBe('t1');
        expect(opts?.limit).toBe(10000); // must override the 50-row default
        return [inboundAfterHours, tooOld];
      },
    };
    const proposalRepo = {
      findByTenant: async () => [proposal({ proposalType: 'create_booking' })],
    } as unknown as ProposalRepository;

    const reporter = new RepoBackedVoiceRoiReporter(
      voiceSessionRepo,
      proposalRepo,
      async () => BUSINESS_HOURS,
    );
    const summary = await reporter.query('t1', now);
    expect(summary.inboundCalls).toBe(1); // tooOld excluded by the 30d window
    expect(summary.afterHoursCaptures).toBe(1);
    expect(summary.bookedByAgent).toBe(1);
  });

  it('omits after-hours attribution when no business-hours loader is wired', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z');
    const voiceSessionRepo = {
      findByTenant: async () => [
        session({ startedAt: new Date('2026-06-07T23:00:00.000Z'), endedAt: new Date('2026-06-07T23:05:00.000Z') }),
      ],
    };
    const proposalRepo = {
      findByTenant: async () => [],
    } as unknown as ProposalRepository;

    const reporter = new RepoBackedVoiceRoiReporter(voiceSessionRepo, proposalRepo);
    const summary = await reporter.query('t1', now);
    expect(summary.inboundCalls).toBe(1);
    expect(summary.afterHoursCaptures).toBe(0);
  });
});
