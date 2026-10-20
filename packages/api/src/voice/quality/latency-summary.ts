/**
 * Voice parity U1 — the owner's reply-gap summary (D-043).
 *
 * Reads `call_transcript_turns` (migration 326), which stores the real
 * caller-perceived reply gap per turn, and reduces a tenant's trailing window
 * to the numbers the Call quality card shows:
 *
 *   - p50 / p95 reply gap and p95 endpoint delay, over REALTIME turns whose
 *     first real reply frame was acked (`reply_gap_ms IS NOT NULL`). Gather
 *     turns never carry a gap and are not estimated.
 *   - p50 / p95 first-audible delay (filler or real reply, whichever played
 *     first, measured from the caller's last word), over realtime turns with a
 *     `first_audible_at` stamp AND a `last_word_at`. A turn that only has the
 *     STT-final fallback anchor is excluded: it omits the endpointing delay and
 *     would bias the number down. A filler makes this look better than the reply
 *     gap by design; the card labels it so.
 *   - the unacked rate: realtime turns whose reply never played, over all
 *     realtime turns with a reply attempt. A reply attempt is a turn whose first
 *     real frame was enqueued, whatever happened to it next (an unacked reason
 *     always implies an enqueue; the OR keeps rows that predate that stamp).
 *     A percentile over acked turns alone would look healthier as playout
 *     failures multiply, so the rate is returned beside it, and `enough` counts
 *     reply attempts so a window where every reply failed still renders.
 *   - the Gather share, by calls (a call is degraded if any turn ran on
 *     Gather; calls are counted by CallSid, since one Twilio call can span
 *     several session ids after a restart) and by turns. The two diverge whenever call lengths differ, so
 *     the card shows the call share and the turn share is for the SLO page.
 *
 * Only caller turns that carry a transport stamp are counted: agent turns and
 * rows written before the migration have no transport and would otherwise dilute
 * the shares. The read runs inside `withTenant`, so RLS applies on top of the
 * explicit tenant_id.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { REPLY_UNACKED_REASONS, type ReplyUnackedReason } from '../call-transcript-turn';

/** Window length when the caller does not pass one. */
const LATENCY_SUMMARY_DEFAULT_DAYS = 7;

/** Fewer realtime reply attempts than this and the card says "not enough calls". */
export const LATENCY_SUMMARY_MIN_SAMPLE_TURNS = 10;

export interface LatencySummary {
  /** Realtime turns with an acked reply gap — the population the percentiles describe. */
  sampleTurns: number;
  p50ReplyGapMs: number | null;
  p95ReplyGapMs: number | null;
  p95EndpointDelayMs: number | null;
  /** First sound the caller heard (filler counts) after their last word. */
  p50FirstAudibleMs: number | null;
  p95FirstAudibleMs: number | null;
  /** Realtime turns whose first real reply frame was enqueued — the unacked-rate denominator. */
  replyAttempts: number;
  unacked: {
    /** Unacked realtime turns ÷ realtime turns with a reply attempt; null when there were none. */
    rate: number | null;
    total: number;
    byReason: Record<ReplyUnackedReason, number>;
  };
  gatherShare: {
    /** Calls with any Gather turn ÷ calls in the window; null for an empty window. */
    calls: number | null;
    /** Gather turns ÷ turns in the window; null for an empty window. Never shown as a call percentage. */
    turns: number | null;
  };
  /** `replyAttempts >= LATENCY_SUMMARY_MIN_SAMPLE_TURNS`; below it the card shows "not enough calls". */
  enough: boolean;
}

export interface LatencySummaryReader {
  read(tenantId: string, opts?: { days?: number }): Promise<LatencySummary>;
}

/**
 * The q-th quantile (0..1) of an ascending array by linear interpolation —
 * the same definition as Postgres `percentile_cont`. `null` for an empty array.
 */
export function percentile(sortedAsc: ReadonlyArray<number>, q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0]!;
  const rank = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loValue = sortedAsc[lo]!;
  const hiValue = sortedAsc[hi]!;
  return loValue + (hiValue - loValue) * (rank - lo);
}

/** `numerator / denominator`, or `null` when the denominator is zero (an empty window is not 0 %). */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function roundedPercentile(sortedAsc: ReadonlyArray<number>, q: number): number | null {
  const v = percentile(sortedAsc, q);
  return v === null ? null : Math.round(v);
}

/** The raw aggregates of the one query; counts arrive as bigint strings from pg. */
export interface LatencySummaryAggregates {
  replyGapsMs: number[] | null;
  endpointDelaysMs: number[] | null;
  firstAudiblesMs: number[] | null;
  unackedByReason: Record<ReplyUnackedReason, number>;
  replyAttempts: number;
  gatherCalls: number;
  calls: number;
  gatherTurns: number;
  turns: number;
}

/** Pure reduction of the aggregates to the summary (the DB-free half of the reader). */
export function summariseLatency(agg: LatencySummaryAggregates): LatencySummary {
  const gaps = [...(agg.replyGapsMs ?? [])].sort((a, b) => a - b);
  const endpointDelays = [...(agg.endpointDelaysMs ?? [])].sort((a, b) => a - b);
  const firstAudibles = [...(agg.firstAudiblesMs ?? [])].sort((a, b) => a - b);
  const unackedTotal = REPLY_UNACKED_REASONS.reduce((sum, r) => sum + agg.unackedByReason[r], 0);
  return {
    sampleTurns: gaps.length,
    p50ReplyGapMs: roundedPercentile(gaps, 0.5),
    p95ReplyGapMs: roundedPercentile(gaps, 0.95),
    p95EndpointDelayMs: roundedPercentile(endpointDelays, 0.95),
    p50FirstAudibleMs: roundedPercentile(firstAudibles, 0.5),
    p95FirstAudibleMs: roundedPercentile(firstAudibles, 0.95),
    replyAttempts: agg.replyAttempts,
    unacked: {
      rate: ratio(unackedTotal, agg.replyAttempts),
      total: unackedTotal,
      byReason: { ...agg.unackedByReason },
    },
    gatherShare: {
      calls: ratio(agg.gatherCalls, agg.calls),
      turns: ratio(agg.gatherTurns, agg.turns),
    },
    enough: agg.replyAttempts >= LATENCY_SUMMARY_MIN_SAMPLE_TURNS,
  };
}

interface AggregateRow {
  reply_gaps_ms: number[] | null;
  endpoint_delays_ms: number[] | null;
  first_audibles_ms: number[] | null;
  unacked_clear_echo: string;
  unacked_ack_timeout: string;
  unacked_stream_closed: string;
  reply_attempts: string;
  gather_calls: string;
  calls: string;
  gather_turns: string;
  turns: string;
}

class PgLatencySummaryReader extends PgBaseRepository implements LatencySummaryReader {
  async read(
    tenantId: string,
    opts: { days?: number } = {},
  ): Promise<LatencySummary> {
    const days = opts.days ?? LATENCY_SUMMARY_DEFAULT_DAYS;
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<AggregateRow>(
        `SELECT
           array_agg(reply_gap_ms ORDER BY reply_gap_ms)
             FILTER (WHERE transport = 'realtime' AND reply_gap_ms IS NOT NULL) AS reply_gaps_ms,
           array_agg(endpoint_delay_ms ORDER BY endpoint_delay_ms)
             FILTER (WHERE transport = 'realtime' AND endpoint_delay_ms IS NOT NULL) AS endpoint_delays_ms,
           array_agg(ROUND(EXTRACT(EPOCH FROM (first_audible_at - last_word_at)) * 1000)::int
                     ORDER BY ROUND(EXTRACT(EPOCH FROM (first_audible_at - last_word_at)) * 1000)::int)
             FILTER (WHERE transport = 'realtime' AND first_audible_at IS NOT NULL
                       AND last_word_at IS NOT NULL)                                                   AS first_audibles_ms,
           COUNT(*) FILTER (WHERE transport = 'realtime' AND reply_unacked_reason = 'clear_echo')     AS unacked_clear_echo,
           COUNT(*) FILTER (WHERE transport = 'realtime' AND reply_unacked_reason = 'ack_timeout')    AS unacked_ack_timeout,
           COUNT(*) FILTER (WHERE transport = 'realtime' AND reply_unacked_reason = 'stream_closed')  AS unacked_stream_closed,
           COUNT(*) FILTER (WHERE transport = 'realtime'
                              AND (first_audio_enqueued_at IS NOT NULL OR reply_unacked_reason IS NOT NULL)) AS reply_attempts,
           COUNT(DISTINCT call_sid) FILTER (WHERE transport = 'gather')                                 AS gather_calls,
           COUNT(DISTINCT call_sid)                                                                     AS calls,
           COUNT(*) FILTER (WHERE transport = 'gather')                                                AS gather_turns,
           COUNT(*)                                                                                    AS turns
           FROM call_transcript_turns
          WHERE tenant_id = $1
            AND speaker = 'caller'
            AND transport IS NOT NULL
            AND started_at >= now() - make_interval(days => $2::int)`,
        [tenantId, days],
      );
      const row = rows[0];
      if (!row) throw new Error('call_transcript_turns: latency summary returned no row');
      return summariseLatency({
        replyGapsMs: row.reply_gaps_ms,
        endpointDelaysMs: row.endpoint_delays_ms,
        firstAudiblesMs: row.first_audibles_ms,
        unackedByReason: {
          clear_echo: Number(row.unacked_clear_echo),
          ack_timeout: Number(row.unacked_ack_timeout),
          stream_closed: Number(row.unacked_stream_closed),
        },
        replyAttempts: Number(row.reply_attempts),
        gatherCalls: Number(row.gather_calls),
        calls: Number(row.calls),
        gatherTurns: Number(row.gather_turns),
        turns: Number(row.turns),
      });
    });
  }
}

export function createPgLatencySummaryReader(pool: Pool): LatencySummaryReader {
  return new PgLatencySummaryReader(pool);
}
