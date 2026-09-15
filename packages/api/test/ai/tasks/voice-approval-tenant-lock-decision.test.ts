/**
 * #1051 follow-up — the pure decision behind the tenant-wide money-approval
 * PIN lock: which strikes count (rolling 24h, after the latest PIN change),
 * when the lock is engaged, and when the owner's one alert is due (once per
 * continuous lock episode). Behaviour at the task seam is pinned in
 * voice-approval-tenant-pin-lock.test.ts; at real Postgres in
 * test/integration/i3-voice-approval-tenant-pin-lock.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  decideTenantPinLock,
  TENANT_PIN_STRIKE_LIMIT,
  TENANT_PIN_STRIKE_WINDOW_MS,
} from '../../../src/ai/tasks/voice-approval-tenant-lock';

const HOUR = 60 * 60 * 1000;

describe('#1051 tenant-wide PIN lock — the policy', () => {
  it('5 strikes in a rolling 24h window', () => {
    expect(TENANT_PIN_STRIKE_LIMIT).toBe(5);
    expect(TENANT_PIN_STRIKE_WINDOW_MS).toBe(24 * HOUR);
  });
});

describe('#1051 tenant-wide PIN lock — decideTenantPinLock (pure)', () => {
  const T0 = new Date('2026-09-15T12:00:00Z').getTime();
  const at = (ms: number) => new Date(T0 + ms);
  const minutes = (n: number) => n * 60 * 1000;
  const fiveStrikes = [0, 1, 2, 3, 4].map((i) => at(minutes(i)));

  it('4 strikes: unlocked; the 5th: locked and an alert is due', () => {
    expect(
      decideTenantPinLock({ strikes: fiveStrikes.slice(0, 4), alerts: [], pinChangedAt: null, now: at(minutes(10)) }),
    ).toEqual({ locked: false, strikeCount: 4, alertDue: false });
    expect(
      decideTenantPinLock({ strikes: fiveStrikes, alerts: [], pinChangedAt: null, now: at(minutes(10)) }),
    ).toEqual({ locked: true, strikeCount: 5, alertDue: true });
  });

  it('no second alert while the lock stays engaged', () => {
    expect(
      decideTenantPinLock({
        strikes: fiveStrikes,
        alerts: [at(minutes(4))],
        pinChangedAt: null,
        now: at(minutes(4) + 6 * HOUR),
      }),
    ).toEqual({ locked: true, strikeCount: 5, alertDue: false });
  });

  it('a strike that ages past 24h releases the lock; a new 5th strike re-engages it and a NEW alert is due', () => {
    const released = decideTenantPinLock({
      strikes: fiveStrikes,
      alerts: [at(minutes(4))],
      pinChangedAt: null,
      now: at(24 * HOUR + 30 * 1000), // the T0 strike aged out
    });
    expect(released).toEqual({ locked: false, strikeCount: 4, alertDue: false });

    const reengaged = decideTenantPinLock({
      strikes: [...fiveStrikes, at(24 * HOUR + 40 * 1000)],
      alerts: [at(minutes(4))],
      pinChangedAt: null,
      now: at(24 * HOUR + 50 * 1000),
    });
    expect(reengaged).toEqual({ locked: true, strikeCount: 5, alertDue: true });
  });

  it('a strike exactly 24h old no longer counts', () => {
    expect(
      decideTenantPinLock({ strikes: fiveStrikes, alerts: [], pinChangedAt: null, now: at(24 * HOUR) }).strikeCount,
    ).toBe(4);
  });

  it('only strikes (and alerts) after the latest PIN change count', () => {
    const decision = decideTenantPinLock({
      strikes: [...fiveStrikes, at(minutes(20))],
      alerts: [at(minutes(4))],
      pinChangedAt: at(minutes(2) + 1),
      now: at(minutes(30)),
    });
    expect(decision).toEqual({ locked: false, strikeCount: 3, alertDue: false });
  });
});
