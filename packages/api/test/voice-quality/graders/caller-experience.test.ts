/**
 * VQ2-009 — Mechanical caller-experience grader tests.
 *
 * Synthetic Observations are constructed by hand-rolling minimal
 * `events` arrays of `transcript_received`, `audio_frame_emitted`, and
 * `lookup_executed` so the audio-timings helpers (VQ2-004) compute
 * deterministic latencies.
 */
import { describe, it, expect } from 'vitest';
import {
  gradeCallerExperience,
  DEFAULT_CALLER_EXPERIENCE_THRESHOLDS,
} from '../../../src/ai/voice-quality/graders/caller-experience';
import type { Observation } from '../../../src/ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import type { VoiceSessionEvent } from '../../../src/ai/agents/customer-calling/voice-session-store';

function makeObservation(partial: Partial<Observation> = {}): Observation {
  return {
    callId: partial.callId ?? 'call-1',
    scriptId: partial.scriptId ?? 'script-1',
    tenantId: partial.tenantId ?? 't-1',
    events: partial.events ?? [],
    proposals: partial.proposals ?? [],
    customerCountDelta: partial.customerCountDelta ?? 0,
    appointmentCountDelta: partial.appointmentCountDelta ?? 0,
    audit: partial.audit ?? [],
    totalCostCents: partial.totalCostCents ?? 0,
    totalDurationMs: partial.totalDurationMs ?? 0,
    perTurnLatencyMs: partial.perTurnLatencyMs ?? [],
    sessionEndedAs: partial.sessionEndedAs ?? 'completed',
    hangupOccurred: partial.hangupOccurred ?? false,
    errors: partial.errors ?? [],
  };
}

function makeScript(partial: Partial<VoiceQualityScript> = {}): VoiceQualityScript {
  return {
    id: partial.id ?? 'script-1',
    bucket: partial.bucket ?? '01-happy-lookups',
    fixtures: partial.fixtures ?? {
      tenant: {},
      customers: [],
    },
    callerId: partial.callerId ?? '+15551234567',
    callerIdBlocked: partial.callerIdBlocked ?? false,
    turns: partial.turns ?? [],
    grading: partial.grading ?? { appliesFloor: [1, 2, 3, 4, 5, 6, 7, 8], appliesDisposition: [] },
    layer2Eligible: partial.layer2Eligible ?? true,
    layer2Only: partial.layer2Only ?? false,
  };
}

/**
 * Build a synthetic event stream:
 *   - `turns` pairs of (transcript_received, audio_frame_emitted) with
 *     a configurable per-turn TTFA.
 *   - `lookups` pairs of (lookup_executed, audio_frame_emitted) with
 *     a configurable per-lookup latency.
 *   - `totalDurationMs` controls the wall-clock span: the first event
 *     sits at t=0 and a trailing audio_frame_emitted is appended at
 *     `totalDurationMs` so `totalCallDurationMs` reads exactly that.
 */
function buildEvents(opts: {
  ttfas?: number[];
  lookupLatencies?: number[];
  totalDurationMs?: number;
}): VoiceSessionEvent[] {
  const events: VoiceSessionEvent[] = [];
  let cursor = 0;

  for (const ttfa of opts.ttfas ?? []) {
    events.push({ type: 'transcript_received', ts: cursor });
    cursor += ttfa;
    events.push({ type: 'audio_frame_emitted', ts: cursor, byteCount: 1024 });
    cursor += 100; // small inter-turn gap
  }

  for (const lat of opts.lookupLatencies ?? []) {
    events.push({
      type: 'lookup_executed',
      skillName: 'lookup_customer',
      durationMs: 50,
      success: true,
      ts: cursor,
    });
    cursor += lat;
    events.push({ type: 'audio_frame_emitted', ts: cursor, byteCount: 1024 });
    cursor += 100;
  }

  if (opts.totalDurationMs !== undefined) {
    const last = events.length === 0 ? 0 : (events[events.length - 1] as { ts: number }).ts;
    if (last < opts.totalDurationMs) {
      events.push({
        type: 'audio_frame_emitted',
        ts: opts.totalDurationMs,
        byteCount: 1024,
      });
    }
  }

  return events;
}

describe('VQ2-009 — gradeCallerExperience', () => {
  it('VQ2-009 — passes when all metrics under thresholds', () => {
    const events = buildEvents({
      ttfas: [200, 200, 200],
      lookupLatencies: [1000],
      totalDurationMs: 30_000,
    });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '01-happy-lookups' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.ttfa).toBe(true);
    expect(result.passes.lookupSpeak).toBe(true);
    expect(result.passes.duration).toBe(true);
    expect(result.failedMetrics).toEqual([]);
    expect(result.totalDurationMs).toBe(30_000);
  });

  it('VQ2-009 — fails ttfa when P95 > 800ms', () => {
    // 900ms TTFA on a single turn -> P95 = 900 (single sample)
    const events = buildEvents({
      ttfas: [900],
      totalDurationMs: 5_000,
    });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '01-happy-lookups' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.ttfa).toBe(false);
    expect(result.failedMetrics).toContain('ttfa');
    expect(result.ttfaP95Ms).toBe(900);
  });

  it('VQ2-009 — fails lookupSpeak when P95 > 2000ms', () => {
    const events = buildEvents({
      lookupLatencies: [2500],
      totalDurationMs: 5_000,
    });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '01-happy-lookups' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.lookupSpeak).toBe(false);
    expect(result.failedMetrics).toContain('lookupSpeak');
    expect(result.lookupP95Ms).toBe(2500);
  });

  it('VQ2-009 — fails duration on happy-path bucket when total > 90s', () => {
    const events = buildEvents({
      ttfas: [200],
      totalDurationMs: 95_000,
    });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '02-happy-booker' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.duration).toBe(false);
    expect(result.failedMetrics).toContain('duration');
    expect(result.totalDurationMs).toBe(95_000);
  });

  it('VQ2-009 — non-happy-path bucket (04-identity-edges) does NOT fail on duration', () => {
    const events = buildEvents({
      ttfas: [200],
      totalDurationMs: 120_000, // way over 90s
    });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '04-identity-edges' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.duration).toBe(true);
    expect(result.failedMetrics).not.toContain('duration');
  });

  it('VQ2-009 — empty TTFA samples → ttfa passes (no measurement = no failure)', () => {
    const obs = makeObservation({ events: [] });
    const script = makeScript({ bucket: '01-happy-lookups' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.ttfa).toBe(true);
    expect(result.passes.lookupSpeak).toBe(true);
    expect(result.ttfaP95Ms).toBe(0);
    expect(result.lookupP95Ms).toBe(0);
    expect(result.failedMetrics).toEqual([]);
  });

  it('VQ2-009 — failedMetrics enumerates ALL failures simultaneously', () => {
    // Both ttfa (900ms) AND duration (95s on happy-path) fail.
    const events = buildEvents({
      ttfas: [900],
      totalDurationMs: 95_000,
    });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '01-happy-lookups' });

    const result = gradeCallerExperience(obs, script);

    expect(result.passes.ttfa).toBe(false);
    expect(result.passes.duration).toBe(false);
    expect(result.failedMetrics).toEqual(
      expect.arrayContaining(['ttfa', 'duration']),
    );
    expect(result.failedMetrics.length).toBe(2);
  });

  it('VQ2-009 — percentile helper: nearest-rank correctness on known fixtures', () => {
    // Verify percentile via the public surface: a 20-sample set where
    // the P95 nearest-rank index = floor(0.95 * 19) = 18.
    // Sorted: 100,100,100,...100 (19 entries), then 9999.
    // Index 18 = 100 → P95 = 100 (NOT 9999, which would be the case if
    // we used a different convention).
    const ttfas = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 100, 9999,
    ];
    const events = buildEvents({ ttfas, totalDurationMs: 60_000 });
    const obs = makeObservation({ events });
    const script = makeScript({ bucket: '01-happy-lookups' });

    const result = gradeCallerExperience(obs, script);

    // floor(0.95 * 19) = 18 → sorted[18] = 100
    expect(result.ttfaP95Ms).toBe(100);
    expect(result.passes.ttfa).toBe(true);

    // Single-sample fixture: P95 of [777] = 777.
    const singleEvents = buildEvents({ ttfas: [777], totalDurationMs: 5_000 });
    const singleObs = makeObservation({ events: singleEvents });
    const singleResult = gradeCallerExperience(singleObs, script);
    expect(singleResult.ttfaP95Ms).toBe(777);
  });

  it('VQ2-009 — DEFAULT_CALLER_EXPERIENCE_THRESHOLDS values match spec (800/2000/90000)', () => {
    expect(DEFAULT_CALLER_EXPERIENCE_THRESHOLDS).toEqual({
      ttfaP95MaxMs: 800,
      lookupP95MaxMs: 2000,
      happyPathMaxMs: 90_000,
    });
  });
});
