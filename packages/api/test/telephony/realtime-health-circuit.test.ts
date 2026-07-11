/**
 * WS3 — RealtimeHealthCircuit unit matrix.
 *
 * Deterministic: a mutable injectable clock is advanced explicitly rather than
 * sleeping. Covers the open threshold, TTL half-open, success reset, and the
 * re-open-after-half-open behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  RealtimeHealthCircuit,
  type Clock,
} from '../../src/telephony/realtime-health-circuit';

class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

describe('RealtimeHealthCircuit', () => {
  it('starts closed', () => {
    const c = new RealtimeHealthCircuit({ clock: new FakeClock() });
    expect(c.isOpen()).toBe(false);
  });

  it('opens only after the threshold of consecutive failures (default 2)', () => {
    const c = new RealtimeHealthCircuit({ clock: new FakeClock() });
    c.recordFailure('deepgram_open_failed');
    expect(c.isOpen()).toBe(false); // one failure is not enough
    c.recordFailure('deepgram_open_failed');
    expect(c.isOpen()).toBe(true); // second consecutive trips it
  });

  it('honours a custom threshold', () => {
    const c = new RealtimeHealthCircuit({ threshold: 3, clock: new FakeClock() });
    c.recordFailure('x');
    c.recordFailure('x');
    expect(c.isOpen()).toBe(false);
    c.recordFailure('x');
    expect(c.isOpen()).toBe(true);
  });

  it('a success before the threshold resets the consecutive count', () => {
    const c = new RealtimeHealthCircuit({ clock: new FakeClock() });
    c.recordFailure('x');
    c.recordSuccess();
    c.recordFailure('x');
    expect(c.isOpen()).toBe(false); // count was reset — this is only failure #1
  });

  it('a success while open closes the breaker immediately', () => {
    const clock = new FakeClock();
    const c = new RealtimeHealthCircuit({ clock });
    c.recordFailure('x');
    c.recordFailure('x');
    expect(c.isOpen()).toBe(true);
    c.recordSuccess();
    expect(c.isOpen()).toBe(false);
  });

  it('stays open until the TTL elapses, then half-opens (allows one probe)', () => {
    const clock = new FakeClock();
    const c = new RealtimeHealthCircuit({ ttlMs: 60_000, clock });
    c.recordFailure('x');
    c.recordFailure('x');
    expect(c.isOpen()).toBe(true);

    clock.advance(59_999);
    expect(c.isOpen()).toBe(true); // still within TTL

    clock.advance(1); // now exactly at TTL
    expect(c.isOpen()).toBe(false); // half-open: probe allowed through
  });

  it('re-opens immediately on a failing probe after half-open', () => {
    const clock = new FakeClock();
    const c = new RealtimeHealthCircuit({ ttlMs: 60_000, clock });
    c.recordFailure('x');
    c.recordFailure('x');
    clock.advance(60_000);
    expect(c.isOpen()).toBe(false); // half-open probe

    // The probe call fails — a single failure trips straight back open because
    // the failure count was not reset on half-open.
    c.recordFailure('x');
    expect(c.isOpen()).toBe(true);
  });

  it('closes for good on a successful probe after half-open', () => {
    const clock = new FakeClock();
    const c = new RealtimeHealthCircuit({ ttlMs: 60_000, clock });
    c.recordFailure('x');
    c.recordFailure('x');
    clock.advance(60_000);
    expect(c.isOpen()).toBe(false); // half-open probe

    c.recordSuccess();
    // A subsequent single failure must NOT re-open (count was reset).
    c.recordFailure('x');
    expect(c.isOpen()).toBe(false);
  });

  // WS16a — documents the multi-call probe window the adapter feed relies on.
  // Because the adapter now votes at CLOSE time, the half-open window stays
  // "open for admission" across MANY concurrent probe calls until one of them
  // terminates and votes. isOpen() clearing openedAt on the first post-TTL call
  // means all subsequent reads are also closed — every admitted call is itself
  // a probe — and a single failing probe re-opens instantly.
  it('half-open is a multi-call window: repeated isOpen() stay false until a vote; one failure re-opens', () => {
    const clock = new FakeClock();
    const c = new RealtimeHealthCircuit({ ttlMs: 60_000, clock });
    c.recordFailure('deepgram_unexpected_close');
    c.recordFailure('deepgram_unexpected_close');
    expect(c.isOpen()).toBe(true);

    clock.advance(60_000);
    // First post-TTL read half-opens (clears the marker) → admits a probe.
    expect(c.isOpen()).toBe(false);
    // The window does NOT re-arm on its own: further calls are ALSO admitted
    // (each is a probe) even though no probe has voted yet.
    expect(c.isOpen()).toBe(false);
    expect(c.isOpen()).toBe(false);

    // One admitted probe finally terminates in failure → re-opens immediately,
    // because the consecutive count was never reset on half-open.
    c.recordFailure('deepgram_unexpected_close');
    expect(c.isOpen()).toBe(true);
  });
});
