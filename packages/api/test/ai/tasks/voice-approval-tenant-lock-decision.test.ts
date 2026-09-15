/**
 * #1051 follow-up — the pure decision behind the tenant-wide money-approval
 * PIN lock, over RESERVED attempts (#1233 review): an attempt is reserved
 * before the PIN is compared and counts until it is cleared (a correct code, a
 * cancel, or a refusal over the budget). Which attempts count (rolling 24h,
 * after the latest PIN change, tolerating small clock skew), when the lock is
 * engaged, which attempt engaged it (the owner-alert claim key), and whether a
 * reserved attempt is inside the budget and may be compared.
 *
 * Behaviour at the task seam: voice-approval-tenant-pin-lock.test.ts; at real
 * Postgres: test/integration/i3-voice-approval-tenant-pin-lock.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  decideTenantPinLock,
  attemptWithinBudget,
  PIN_ATTEMPT_SETTLE_MS,
  TENANT_PIN_STRIKE_LIMIT,
  TENANT_PIN_STRIKE_WINDOW_MS,
  PIN_LOCK_CLOCK_SKEW_MS,
} from '../../../src/ai/tasks/voice-approval-tenant-lock';
import { InMemoryVoiceApprovalPinLockAlertRepository } from '../../../src/settings/voice-approval-pin-lock-alert';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-15T12:00:00Z').getTime();
const at = (ms: number) => new Date(T0 + ms);
const minutes = (n: number) => n * 60 * 1000;
const attempt = (id: string, ms: number) => ({ id, at: at(ms) });
const five = [0, 1, 2, 3, 4].map((i) => attempt(`a${i}`, minutes(i)));
const none = new Set<string>();
/** Every id a test uses has a recorded wrong-code outcome. */
const ALL = new Set(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'ahead', 'bogus', 'z', 'b', 'c', 'a', 'y']);

describe('#1051 tenant-wide PIN lock — the policy', () => {
  it('5 strikes in a rolling 24h window, tolerating a minute of clock skew', () => {
    expect(TENANT_PIN_STRIKE_LIMIT).toBe(5);
    expect(TENANT_PIN_STRIKE_WINDOW_MS).toBe(24 * HOUR);
    expect(PIN_LOCK_CLOCK_SKEW_MS).toBe(60 * 1000);
  });
});

describe('#1051 tenant-wide PIN lock — decideTenantPinLock (pure)', () => {
  it('4 counted attempts: unlocked; the 5th: locked, engaged by the 5th attempt', () => {
    expect(
      decideTenantPinLock({ attempts: five.slice(0, 4), clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(minutes(10)) }),
    ).toEqual({ locked: false, strikeCount: 4, engagingAttemptId: null });
    expect(
      decideTenantPinLock({ attempts: five, clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(minutes(10)) }),
    ).toEqual({ locked: true, strikeCount: 5, engagingAttemptId: 'a4' });
  });

  it('cleared attempts (a correct code, a cancel, a refusal) never count', () => {
    const decision = decideTenantPinLock({
      attempts: [...five, attempt('a5', minutes(5))],
      clearedIds: new Set(['a1', 'a5']),
      settledIds: ALL,
      pinChangedAt: null,
      now: at(minutes(10)),
    });
    expect(decision).toEqual({ locked: false, strikeCount: 4, engagingAttemptId: null });
  });

  it('an attempt still pending (reserved, not yet resolved) counts — a crash between reserve and compare fails closed', () => {
    expect(
      decideTenantPinLock({ attempts: five, clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(minutes(4)) }).strikeCount,
    ).toBe(5);
  });

  it('the engaging attempt — the alert claim key — is stable while the lock holds, even with extra transient attempts', () => {
    const later = decideTenantPinLock({
      attempts: [...five, attempt('a5', minutes(30))], // a refused attempt not yet cleared
      clearedIds: none,
      settledIds: ALL,
      pinChangedAt: null,
      now: at(6 * HOUR),
    });
    expect(later).toEqual({ locked: true, strikeCount: 6, engagingAttemptId: 'a4' });
  });

  it('a strike aging past 24h releases the lock; a new 5th attempt re-engages it with a NEW key', () => {
    const released = decideTenantPinLock({
      attempts: five,
      clearedIds: none,
      settledIds: ALL,
      pinChangedAt: null,
      now: at(24 * HOUR + 30 * 1000), // a0 aged out
    });
    expect(released).toEqual({ locked: false, strikeCount: 4, engagingAttemptId: null });

    const reengaged = decideTenantPinLock({
      attempts: [...five, attempt('a6', 24 * HOUR + 40 * 1000)],
      clearedIds: none,
      settledIds: ALL,
      pinChangedAt: null,
      now: at(24 * HOUR + 50 * 1000),
    });
    expect(reengaged).toEqual({ locked: true, strikeCount: 5, engagingAttemptId: 'a6' });
  });

  it('an attempt exactly 24h old no longer counts', () => {
    expect(
      decideTenantPinLock({ attempts: five, clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(24 * HOUR) }).strikeCount,
    ).toBe(4);
  });

  it('only attempts after the latest PIN change count', () => {
    expect(
      decideTenantPinLock({
        attempts: [...five, attempt('a5', minutes(20))],
        clearedIds: none,
        settledIds: ALL,
        pinChangedAt: at(minutes(2) + 1),
        now: at(minutes(30)),
      }),
    ).toEqual({ locked: false, strikeCount: 3, engagingAttemptId: null });
  });

  it('tolerates small clock skew: an attempt stamped up to a minute AHEAD of now still counts; further ahead does not', () => {
    const skewed = [...five.slice(0, 4), attempt('ahead', minutes(10) + 30 * 1000)];
    expect(
      decideTenantPinLock({ attempts: skewed, clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(minutes(10)) }),
    ).toEqual({ locked: true, strikeCount: 5, engagingAttemptId: 'ahead' });

    const farAhead = [...five.slice(0, 4), attempt('bogus', minutes(10) + 5 * 60 * 1000)];
    expect(
      decideTenantPinLock({ attempts: farAhead, clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(minutes(10)) })
        .strikeCount,
    ).toBe(4);
  });

  it('#1233 re-run — a still-PENDING attempt (in flight, or refused but not yet cleared) counts for the lock but never keys the episode: the key is stable before and after it clears', () => {
    // 4 settled strikes; R was reserved a moment before A but committed after
    // A counted, so A was compared (and failed) while R was refused over the
    // budget and has not been cleared yet.
    const settled = new Set(['a0', 'a1', 'a2', 'a3', 'a5']);
    const w = [0, 1, 2, 3].map((i) => attempt(`a${i}`, minutes(i)));
    const refusedInFlight = attempt('r', minutes(4));
    const compared = attempt('a5', minutes(4) + 1000);
    const all = [...w, refusedInFlight, compared];

    const before = decideTenantPinLock({ attempts: all, clearedIds: none, settledIds: settled, pinChangedAt: null, now: at(minutes(5)) });
    expect(before).toEqual({ locked: true, strikeCount: 6, engagingAttemptId: 'a5' });

    const after = decideTenantPinLock({ attempts: all, clearedIds: new Set(['r']), settledIds: settled, pinChangedAt: null, now: at(minutes(5)) });
    expect(after).toEqual({ locked: true, strikeCount: 5, engagingAttemptId: 'a5' });
  });

  it('#1233 re-run — while a counted attempt is still pending, no episode key exists yet (its outcome may still clear it)', () => {
    const w = [0, 1, 2, 3].map((i) => attempt(`a${i}`, minutes(i)));
    const inFlight = attempt('p', minutes(4));
    expect(
      decideTenantPinLock({
        attempts: [...w, inFlight],
        clearedIds: none,
        settledIds: new Set(['a0', 'a1', 'a2', 'a3']),
        pinChangedAt: null,
        now: at(minutes(4) + 1000),
      }),
    ).toEqual({ locked: true, strikeCount: 5, engagingAttemptId: null });
  });

  it('#1233 re-run — an attempt pending longer than the settle time is treated as a spent guess (a crash between reserve and outcome)', () => {
    expect(PIN_ATTEMPT_SETTLE_MS).toBe(2 * 60 * 1000);
    const w = [0, 1, 2, 3].map((i) => attempt(`a${i}`, minutes(i)));
    const crashed = attempt('p', minutes(4));
    expect(
      decideTenantPinLock({
        attempts: [...w, crashed],
        clearedIds: none,
        settledIds: new Set(['a0', 'a1', 'a2', 'a3']),
        pinChangedAt: null,
        now: at(minutes(4) + PIN_ATTEMPT_SETTLE_MS + 1),
      }),
    ).toEqual({ locked: true, strikeCount: 5, engagingAttemptId: 'p' });
  });

  it('orders ties by id so every caller derives the same engaging attempt', () => {
    const tied = [attempt('z', 0), attempt('b', 0), attempt('c', 0), attempt('a', 0), attempt('y', 0)];
    expect(
      decideTenantPinLock({ attempts: tied, clearedIds: none, settledIds: ALL, pinChangedAt: null, now: at(minutes(1)) })
        .engagingAttemptId,
    ).toBe('z');
  });
});

describe('#1051 tenant-wide PIN lock — attemptWithinBudget (the compare gate)', () => {
  it('a reserved attempt may be compared only while the count INCLUDING it is within the limit', () => {
    const count = (n: number) => ({ locked: n >= 5, strikeCount: n, engagingAttemptId: null });
    expect(attemptWithinBudget(count(1))).toBe(true);
    expect(attemptWithinBudget(count(5))).toBe(true); // the 5th guess
    expect(attemptWithinBudget(count(6))).toBe(false); // never a 6th
  });
});

describe('#1051 owner alert claim — InMemoryVoiceApprovalPinLockAlertRepository', () => {
  it('the first claim for a (tenant, episode) wins; repeats lose; other tenants and episodes are independent', async () => {
    const repo = new InMemoryVoiceApprovalPinLockAlertRepository();
    const claim = (tenantId: string, episodeKey: string) =>
      repo.claim({ tenantId, episodeKey, sessionId: 's', strikeCount: 5 });
    expect(await claim('t1', 'a4')).toBe(true);
    expect(await claim('t1', 'a4')).toBe(false);
    expect(await claim('t2', 'a4')).toBe(true);
    expect(await claim('t1', 'a6')).toBe(true);
    const rows = repo.getAll();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ tenantId: 't1', episodeKey: 'a4', sessionId: 's', strikeCount: 5 });
  });
});
