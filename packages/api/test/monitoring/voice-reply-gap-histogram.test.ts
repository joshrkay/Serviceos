/**
 * U1 — the reply-gap metrics: `voice_reply_gap_ms` (labelled by anchor so the
 * last-word SLO population is never mixed with the STT-final fallback),
 * `voice_reply_unacked_total` and `voice_reply_stamp_lost_total`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  voiceReplyGapMs,
  voiceReplyUnackedTotal,
  voiceReplyStampLostTotal,
  voiceTurnLatencyMs,
} from '../../src/monitoring/metrics';

async function histogramCount(anchor: string): Promise<number> {
  const snap = await voiceReplyGapMs.get();
  return (
    snap.values.find((v) => v.metricName === 'voice_reply_gap_ms_count' && v.labels.anchor === anchor)?.value ?? 0
  );
}

async function histogramSum(anchor: string): Promise<number> {
  const snap = await voiceReplyGapMs.get();
  return (
    snap.values.find((v) => v.metricName === 'voice_reply_gap_ms_sum' && v.labels.anchor === anchor)?.value ?? 0
  );
}

describe('voice_reply_gap_ms', () => {
  beforeEach(() => {
    voiceReplyGapMs.reset();
    voiceReplyUnackedTotal.reset();
    voiceReplyStampLostTotal.reset();
  });

  it('keeps the last_word and stt_final populations apart', async () => {
    voiceReplyGapMs.observe({ anchor: 'last_word' }, 1400);
    voiceReplyGapMs.observe({ anchor: 'last_word' }, 900);
    voiceReplyGapMs.observe({ anchor: 'stt_final' }, 600);

    expect(await histogramCount('last_word')).toBe(2);
    expect(await histogramSum('last_word')).toBe(2300);
    expect(await histogramCount('stt_final')).toBe(1);
    expect(await histogramSum('stt_final')).toBe(600);
  });

  it('shares the voice_turn_latency_ms buckets so the two read side by side', async () => {
    voiceTurnLatencyMs.reset();
    voiceReplyGapMs.observe({ anchor: 'last_word' }, 1200);
    voiceTurnLatencyMs.observe(1200);
    const edges = async (hist: typeof voiceReplyGapMs | typeof voiceTurnLatencyMs, metric: string) =>
      (await hist.get()).values
        .filter((v) => v.metricName === `${metric}_bucket`)
        .map((v) => String(v.labels.le));
    const gapEdges = await edges(voiceReplyGapMs, 'voice_reply_gap_ms');
    expect(gapEdges).toEqual(await edges(voiceTurnLatencyMs, 'voice_turn_latency_ms'));
    // 1,500 ms (the SLO threshold) is an explicit bucket edge.
    expect(gapEdges).toContain('1500');
  });

  it('counts unacked replies per reason', async () => {
    voiceReplyUnackedTotal.inc({ reason: 'clear_echo' });
    voiceReplyUnackedTotal.inc({ reason: 'ack_timeout' });
    voiceReplyUnackedTotal.inc({ reason: 'ack_timeout' });
    const snap = await voiceReplyUnackedTotal.get();
    const byReason = Object.fromEntries(snap.values.map((v) => [v.labels.reason, v.value]));
    expect(byReason).toEqual({ clear_echo: 1, ack_timeout: 2 });
  });
});
