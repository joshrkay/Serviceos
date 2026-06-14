import { describe, it, expect } from 'vitest';
import {
  renderEndOfDayDigest,
  renderMorningBriefing,
  isEmptyDigest,
  DigestData,
} from '../../../src/notifications/digest/render';

function data(overrides: Partial<DigestData> = {}): DigestData {
  return {
    jobsCompleted: 0,
    revenueCents: 0,
    pendingApprovals: 0,
    overdueInvoices: 0,
    tomorrowAppointments: 0,
    todayAppointments: 0,
    ...overrides,
  };
}

describe('renderEndOfDayDigest', () => {
  it('summarizes a busy day', () => {
    const sms = renderEndOfDayDigest(
      data({ jobsCompleted: 3, revenueCents: 215_000, pendingApprovals: 2, tomorrowAppointments: 4 }),
    );
    expect(sms).toContain('3 jobs done');
    expect(sms).toContain('$2,150 collected');
    expect(sms).toContain('2 things need your OK');
    expect(sms).toContain('Tomorrow: 4 jobs booked');
    expect(sms.length).toBeLessThanOrEqual(320);
  });

  it('uses singular forms + a cents amount', () => {
    const sms = renderEndOfDayDigest(
      data({ jobsCompleted: 1, revenueCents: 12_550, pendingApprovals: 1, tomorrowAppointments: 1 }),
    );
    expect(sms).toContain('1 job done');
    expect(sms).toContain('$125.50 collected');
    expect(sms).toContain('1 thing needs your OK');
    expect(sms).toContain('Tomorrow: 1 job booked');
  });

  it('reassures on a quiet day', () => {
    const sms = renderEndOfDayDigest(data());
    expect(sms).toContain('No jobs marked done');
    expect(sms).toContain('Nothing needs your OK');
    expect(sms).toContain('nothing booked yet');
  });

  it('surfaces overdue invoices when present', () => {
    expect(renderEndOfDayDigest(data({ overdueInvoices: 2 }))).toContain('2 invoices are overdue');
    expect(renderEndOfDayDigest(data({ overdueInvoices: 1 }))).toContain('1 invoice is overdue');
  });
});

describe('renderMorningBriefing', () => {
  it('leads with today\'s booked work and surfaces leftovers', () => {
    const sms = renderMorningBriefing(
      data({ todayAppointments: 4, pendingApprovals: 2, overdueInvoices: 1 }),
    );
    expect(sms).toContain('Good morning!');
    expect(sms).toContain('Today: 4 jobs booked');
    expect(sms).toContain('2 things need your OK from yesterday');
    expect(sms).toContain('1 invoice is overdue');
    expect(sms.length).toBeLessThanOrEqual(320);
  });

  it('omits the approvals/overdue clauses when there are none', () => {
    const sms = renderMorningBriefing(data({ todayAppointments: 2 }));
    expect(sms).toContain('Today: 2 jobs booked');
    expect(sms).not.toMatch(/need your OK/);
    expect(sms).not.toMatch(/overdue/);
  });
});

describe('isEmptyDigest', () => {
  it('is true only when every metric is zero', () => {
    expect(isEmptyDigest(data())).toBe(true);
    expect(isEmptyDigest(data({ pendingApprovals: 1 }))).toBe(false);
    expect(isEmptyDigest(data({ revenueCents: 1 }))).toBe(false);
  });
});
