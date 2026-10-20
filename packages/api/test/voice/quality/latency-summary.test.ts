/**
 * Voice parity U1 — pure halves of the latency summary: the percentile and
 * null-safe rate helpers, and the aggregate → summary reduction. The query
 * itself is pinned on real columns by
 * test/integration/voice-quality-latency-summary.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  LATENCY_SUMMARY_MIN_SAMPLE_TURNS,
  percentile,
  ratio,
  summariseLatency,
  type LatencySummaryAggregates,
} from '../../../src/voice/quality/latency-summary';

const EMPTY: LatencySummaryAggregates = {
  replyGapsMs: null,
  endpointDelaysMs: null,
  firstAudiblesMs: null,
  unackedByReason: { clear_echo: 0, ack_timeout: 0, stream_closed: 0 },
  replyAttempts: 0,
  gatherCalls: 0,
  calls: 0,
  gatherTurns: 0,
  turns: 0,
};

describe('percentile', () => {
  it('is null for an empty array and the value itself for one element', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([800], 0.95)).toBe(800);
  });

  it('interpolates linearly like percentile_cont', () => {
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(250);
    expect(percentile([100, 200, 300, 400, 500], 0.5)).toBe(300);
    // rank = 0.95 * 3 = 2.85 → 300 + 0.85 * 100
    expect(percentile([100, 200, 300, 400], 0.95)).toBeCloseTo(385, 6);
  });

  it('clamps the quantile to 0..1', () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 2)).toBe(3);
  });
});

describe('ratio', () => {
  it('divides, and is null (not 0, not NaN) for an empty denominator', () => {
    expect(ratio(2, 14)).toBeCloseTo(2 / 14, 10);
    expect(ratio(0, 5)).toBe(0);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(3, 0)).toBeNull();
  });
});

describe('summariseLatency', () => {
  it('an empty window is all nulls, zero counts and not enough', () => {
    expect(summariseLatency(EMPTY)).toEqual({
      sampleTurns: 0,
      p50ReplyGapMs: null,
      p95ReplyGapMs: null,
      p95EndpointDelayMs: null,
      p50FirstAudibleMs: null,
      p95FirstAudibleMs: null,
      replyAttempts: 0,
      unacked: { rate: null, total: 0, byReason: { clear_echo: 0, ack_timeout: 0, stream_closed: 0 } },
      gatherShare: { calls: null, turns: null },
      enough: false,
    });
  });

  it('sorts defensively, rounds to whole ms and totals the unacked reasons', () => {
    const s = summariseLatency({
      ...EMPTY,
      replyGapsMs: [900, 700, 800, 1000, 1100, 600, 1200, 500, 1300, 400],
      endpointDelaysMs: [300, 100, 200],
      firstAudiblesMs: [500, 300, 400, 200, 600],
      unackedByReason: { clear_echo: 1, ack_timeout: 2, stream_closed: 0 },
      replyAttempts: 13,
      gatherCalls: 1,
      calls: 4,
      gatherTurns: 2,
      turns: 30,
    });
    expect(s.sampleTurns).toBe(10);
    expect(s.p50ReplyGapMs).toBe(850);
    expect(s.p95ReplyGapMs).toBe(1255);
    expect(s.p95EndpointDelayMs).toBe(290);
    expect(s.p50FirstAudibleMs).toBe(400);
    expect(s.p95FirstAudibleMs).toBe(580);
    expect(s.replyAttempts).toBe(13);
    expect(s.unacked.total).toBe(3);
    expect(s.unacked.rate).toBeCloseTo(3 / 13, 10);
    expect(s.gatherShare.calls).toBe(0.25);
    expect(s.gatherShare.turns).toBeCloseTo(2 / 30, 10);
    expect(s.enough).toBe(true);
  });

  it('is "enough" exactly at the minimum number of reply attempts', () => {
    expect(summariseLatency({ ...EMPTY, replyAttempts: LATENCY_SUMMARY_MIN_SAMPLE_TURNS }).enough).toBe(true);
    expect(summariseLatency({ ...EMPTY, replyAttempts: LATENCY_SUMMARY_MIN_SAMPLE_TURNS - 1 }).enough).toBe(false);
  });

  it('a window where every reply went unacked is still enough, with null percentiles and a 100 % unacked rate', () => {
    const s = summariseLatency({
      ...EMPTY,
      unackedByReason: { clear_echo: 0, ack_timeout: 12, stream_closed: 0 },
      replyAttempts: 12,
    });
    expect(s.enough).toBe(true);
    expect(s.sampleTurns).toBe(0);
    expect(s.p95ReplyGapMs).toBeNull();
    expect(s.unacked.rate).toBe(1);
  });
});
