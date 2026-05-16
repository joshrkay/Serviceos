import { describe, it, expect, afterEach } from 'vitest';
import { evaluateTrialCap, TRIAL_LIMITS } from '../../src/voice/trial-limits';

afterEach(() => {
  delete process.env.TRIAL_VOICE_MINUTES_DAILY_OVERRIDE;
  delete process.env.TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE;
});

describe('evaluateTrialCap', () => {
  it('allows when active subscription (no cap)', () => {
    expect(
      evaluateTrialCap({
        status: 'active',
        dailyMinutes: 999,
        trialTotalMinutes: 999,
        concurrentCalls: 99,
      }).allowed,
    ).toBe(true);
  });

  it('blocks when no subscription (status null)', () => {
    const r = evaluateTrialCap({
      status: null,
      dailyMinutes: 0,
      trialTotalMinutes: 0,
      concurrentCalls: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_billing');
  });

  it('blocks when status canceled or past_due', () => {
    expect(
      evaluateTrialCap({
        status: 'canceled',
        dailyMinutes: 0,
        trialTotalMinutes: 0,
        concurrentCalls: 0,
      }).reason,
    ).toBe('no_billing');
    expect(
      evaluateTrialCap({
        status: 'past_due',
        dailyMinutes: 0,
        trialTotalMinutes: 0,
        concurrentCalls: 0,
      }).reason,
    ).toBe('no_billing');
  });

  it('blocks when trialing and daily cap reached', () => {
    const r = evaluateTrialCap({
      status: 'trialing',
      dailyMinutes: TRIAL_LIMITS.DAILY_MINUTES,
      trialTotalMinutes: 0,
      concurrentCalls: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('trial_cap_daily');
  });

  it('blocks when trialing and trial total reached', () => {
    const r = evaluateTrialCap({
      status: 'trialing',
      dailyMinutes: 0,
      trialTotalMinutes: TRIAL_LIMITS.TRIAL_TOTAL_MINUTES,
      concurrentCalls: 0,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('trial_cap_total');
  });

  it('blocks when concurrent cap reached', () => {
    const r = evaluateTrialCap({
      status: 'trialing',
      dailyMinutes: 0,
      trialTotalMinutes: 0,
      concurrentCalls: TRIAL_LIMITS.CONCURRENT_CALLS,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('trial_cap_concurrent');
  });

  it('allows when trialing and well under all caps', () => {
    expect(
      evaluateTrialCap({
        status: 'trialing',
        dailyMinutes: 5,
        trialTotalMinutes: 10,
        concurrentCalls: 0,
      }).allowed,
    ).toBe(true);
  });

  it('respects env override for daily cap', () => {
    process.env.TRIAL_VOICE_MINUTES_DAILY_OVERRIDE = '5';
    expect(
      evaluateTrialCap({
        status: 'trialing',
        dailyMinutes: 6,
        trialTotalMinutes: 0,
        concurrentCalls: 0,
      }).reason,
    ).toBe('trial_cap_daily');
  });
});
