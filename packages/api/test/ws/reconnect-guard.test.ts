/**
 * Unit tests for the token-bucket ReconnectGuard and the memory-watermark
 * helper. Uses fake timers so refill math is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ReconnectGuard,
  DEFAULT_RECONNECT_GUARD,
  isMemoryWatermarkHigh,
} from '../../src/ws/reconnect-guard';

const BASE = new Date('2026-05-01T00:00:00.000Z').getTime();

describe('ReconnectGuard.tryAdmit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits up to capacity, then refuses with a positive retry-after', () => {
    const guard = new ReconnectGuard(); // capacity 10, 2 tokens/sec
    for (let i = 0; i < 10; i++) {
      expect(guard.tryAdmit({ ip: '1.2.3.4', tenantId: 't1' })).toBe(0);
    }
    const retry = guard.tryAdmit({ ip: '1.2.3.4', tenantId: 't1' });
    expect(retry).toBeGreaterThan(0);
    // deficit 1 / refillRate 2 * 1000 = 500ms
    expect(retry).toBe(500);
  });

  it('refills tokens over elapsed time (capped at capacity)', () => {
    const guard = new ReconnectGuard();
    for (let i = 0; i < 10; i++) guard.tryAdmit({ ip: 'a', tenantId: 't' });
    expect(guard.tryAdmit({ ip: 'a', tenantId: 't' })).toBeGreaterThan(0);

    // Advance 1s → 2 tokens refilled at 2/sec.
    vi.setSystemTime(BASE + 1000);
    expect(guard.tryAdmit({ ip: 'a', tenantId: 't' })).toBe(0);
    expect(guard.tryAdmit({ ip: 'a', tenantId: 't' })).toBe(0);
    expect(guard.tryAdmit({ ip: 'a', tenantId: 't' })).toBeGreaterThan(0);
  });

  it('tightens capacity and refill rate when tighten=true', () => {
    const guard = new ReconnectGuard();
    // factor 0.25 → cap = floor(10*0.25)=2, refillRate = max(0.1, 2*0.25)=0.5
    expect(guard.tryAdmit({ ip: 'b', tenantId: 't', tighten: true })).toBe(0);
    expect(guard.tryAdmit({ ip: 'b', tenantId: 't', tighten: true })).toBe(0);
    const retry = guard.tryAdmit({ ip: 'b', tenantId: 't', tighten: true });
    // deficit 1 / refillRate 0.5 * 1000 = 2000ms
    expect(retry).toBe(2000);
  });

  it('keys buckets separately by ip + tenant (and anon when tenant omitted)', () => {
    const guard = new ReconnectGuard({ capacity: 1, refillTokensPerSec: 1, tightenedFactor: 0.25 });
    expect(guard.tryAdmit({ ip: 'x', tenantId: 't1' })).toBe(0);
    expect(guard.tryAdmit({ ip: 'x', tenantId: 't1' })).toBeGreaterThan(0); // same bucket exhausted
    expect(guard.tryAdmit({ ip: 'x', tenantId: 't2' })).toBe(0); // different tenant → fresh bucket
    expect(guard.tryAdmit({ ip: 'x' })).toBe(0); // anon → fresh bucket
  });

  it('uses the documented defaults', () => {
    expect(DEFAULT_RECONNECT_GUARD).toEqual({ capacity: 10, refillTokensPerSec: 2, tightenedFactor: 0.25 });
  });
});

describe('isMemoryWatermarkHigh', () => {
  it('returns true when threshold is 0 (any usage exceeds it)', () => {
    expect(isMemoryWatermarkHigh(0)).toBe(true);
  });

  it('returns false when threshold is at/above 1 (usage never exceeds the heap limit)', () => {
    expect(isMemoryWatermarkHigh(1)).toBe(false);
  });
});
