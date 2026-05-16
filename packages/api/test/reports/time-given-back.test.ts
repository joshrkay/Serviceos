import { describe, it, expect } from 'vitest';
import {
  computeTimeGivenBack,
  currentWeekWindow,
  TimeGivenBackInput,
} from '../../src/reports/time-given-back';
import { TIME_CREDIT_VERSION } from '../../src/reports/time-credits';
import type { Proposal, ProposalType, ProposalStatus } from '../../src/proposals/proposal';

const WEEK_START = new Date('2026-05-11T00:00:00.000Z');
const WEEK_END = new Date('2026-05-18T00:00:00.000Z');

function proposal(over: {
  proposalType: ProposalType;
  status?: ProposalStatus;
  executedAt?: Date;
  updatedAt?: Date;
}): Proposal {
  const now = new Date('2026-05-13T12:00:00.000Z');
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

describe('computeTimeGivenBack', () => {
  const base: Omit<TimeGivenBackInput, 'proposals' | 'voiceSessions'> = {
    hourlyRateCents: 12000, // $120/hr
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
  };

  it('sums credits for executed proposals inside the window', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate' }), // 12 min
        proposal({ proposalType: 'record_payment' }), // 3 min
        proposal({ proposalType: 'add_note' }), // 1 min
      ],
      voiceSessions: [],
    });
    expect(summary.totalMinutes).toBe(16);
    expect(summary.receipt.proposalsHandled).toBe(3);
  });

  it('ignores proposals that are not executed', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate', status: 'executed' }),
        proposal({ proposalType: 'draft_estimate', status: 'draft' }),
        proposal({ proposalType: 'draft_estimate', status: 'rejected' }),
      ],
      voiceSessions: [],
    });
    expect(summary.totalMinutes).toBe(12);
    expect(summary.receipt.proposalsHandled).toBe(1);
  });

  it('ignores executed proposals outside the week window', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate', executedAt: new Date('2026-05-13') }),
        proposal({ proposalType: 'draft_estimate', executedAt: new Date('2026-05-01') }),
        proposal({ proposalType: 'draft_estimate', executedAt: new Date('2026-05-20') }),
      ],
      voiceSessions: [],
    });
    expect(summary.totalMinutes).toBe(12);
  });

  it('falls back to updatedAt when executedAt is missing', () => {
    const p = proposal({ proposalType: 'add_note' });
    delete (p as { executedAt?: Date }).executedAt;
    p.updatedAt = new Date('2026-05-13T09:00:00.000Z');
    const summary = computeTimeGivenBack({ ...base, proposals: [p], voiceSessions: [] });
    expect(summary.totalMinutes).toBe(1);
  });

  it('credits handled calls inside the window', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [],
      voiceSessions: [
        { endedAt: new Date('2026-05-12') },
        { endedAt: new Date('2026-05-14') },
        { endedAt: new Date('2026-05-01') }, // outside window
        { endedAt: undefined }, // still open — not counted
      ],
    });
    expect(summary.totalMinutes).toBe(16); // 2 calls × 8 min
    expect(summary.receipt.callsAnswered).toBe(2);
  });

  it('converts minutes to hours and a dollar value via the hourly rate', () => {
    const summary = computeTimeGivenBack({
      ...base,
      hourlyRateCents: 12000,
      proposals: [
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'draft_invoice' }),
        proposal({ proposalType: 'draft_invoice' }),
      ],
      // 12+12+8+8 = 40 min ... add a call for 8 → 48 min = 0.8 h
      voiceSessions: [{ endedAt: new Date('2026-05-12') }],
    });
    expect(summary.totalMinutes).toBe(48);
    expect(summary.totalHours).toBe(0.8);
    // 0.8 h × $120/h = $96.00 = 9600 cents
    expect(summary.dollarValueCents).toBe(9600);
  });

  it('returns dollarValueCents null when the hourly rate is unset', () => {
    const summary = computeTimeGivenBack({
      ...base,
      hourlyRateCents: null,
      proposals: [proposal({ proposalType: 'draft_estimate' })],
      voiceSessions: [],
    });
    expect(summary.totalHours).toBe(0.2);
    expect(summary.dollarValueCents).toBeNull();
  });

  it('records a per-type breakdown and stamps the credit version', () => {
    const summary = computeTimeGivenBack({
      ...base,
      proposals: [
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'draft_estimate' }),
        proposal({ proposalType: 'record_payment' }),
      ],
      voiceSessions: [],
    });
    expect(summary.receipt.byProposalType.draft_estimate).toBe(2);
    expect(summary.receipt.byProposalType.record_payment).toBe(1);
    expect(summary.creditVersion).toBe(TIME_CREDIT_VERSION);
  });
});

describe('currentWeekWindow', () => {
  it('returns a 7-day [start, end) window ending at `now`', () => {
    const now = new Date('2026-05-14T15:30:00.000Z');
    const { weekStart, weekEnd } = currentWeekWindow(now);
    expect(weekEnd.getTime()).toBe(now.getTime());
    expect(weekEnd.getTime() - weekStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
