/**
 * VQ2-004 — pure helpers that derive latency stats from a unified
 * `VoiceSessionEvent` timeline. The harness collects these events via
 * `AgentEventBus` and feeds the array straight in. The helpers do no
 * I/O and have no side effects, so graders can run them on cassette
 * playback or real-call captures interchangeably.
 *
 * Conventions:
 * - Time-to-first-audio (TTFA) is measured from the moment the STT
 *   provider returned a final transcript (`transcript_received`) to
 *   the moment the first outbound audio chunk landed on the
 *   WebSocket (`audio_frame_emitted`). Layer 2 uses Whisper batch,
 *   not streaming VAD — `transcript_received` is therefore the
 *   "caller stopped talking" proxy.
 * - Lookup-to-speak latency is measured from a `lookup_executed`
 *   event to the next `audio_frame_emitted`. It captures the
 *   perceived latency of "agent went silent to query the DB and
 *   is now responding."
 */

import type { VoiceSessionEvent } from '../../agents/customer-calling/voice-session-store';

/**
 * Compute per-turn TTFA latencies (in ms) from an event timeline.
 *
 * Algorithm: walk events in order. When `transcript_received` is seen,
 * remember its timestamp. When `audio_frame_emitted` is seen and a
 * pending transcript is held, push the delta and clear the slot. A
 * second `transcript_received` before any `audio_frame_emitted`
 * overwrites the slot — the "agent never produced audio for that
 * turn" case is dropped intentionally so a stuck synthesis doesn't
 * skew the median upward.
 */
export function ttfaPerTurn(events: ReadonlyArray<VoiceSessionEvent>): number[] {
  const ttfas: number[] = [];
  let pendingTranscriptTs: number | null = null;
  for (const e of events) {
    if (e.type === 'transcript_received') {
      pendingTranscriptTs = e.ts;
    } else if (e.type === 'audio_frame_emitted' && pendingTranscriptTs !== null) {
      ttfas.push(e.ts - pendingTranscriptTs);
      pendingTranscriptTs = null;
    }
  }
  return ttfas;
}

/**
 * Compute lookup→speak latencies (in ms) from an event timeline.
 *
 * Pairs each `lookup_executed` with the next `audio_frame_emitted`.
 * A second `lookup_executed` before any audio frame overwrites the
 * pending slot for the same reason as `ttfaPerTurn`.
 */
export function lookupToSpeakLatency(events: ReadonlyArray<VoiceSessionEvent>): number[] {
  const latencies: number[] = [];
  let pendingLookupTs: number | null = null;
  for (const e of events) {
    if (e.type === 'lookup_executed') {
      pendingLookupTs = e.ts;
    } else if (e.type === 'audio_frame_emitted' && pendingLookupTs !== null) {
      latencies.push(e.ts - pendingLookupTs);
      pendingLookupTs = null;
    }
  }
  return latencies;
}

/**
 * Total wall-clock duration (in ms) of a call, measured from the
 * timestamp on the first event to the timestamp on the last. Returns
 * 0 for empty inputs. Events without a numeric `ts` (the legacy
 * pre-VQ-003 variants `transition`/`ended`/`proposal_created`) are
 * silently skipped.
 */
export function totalCallDurationMs(events: ReadonlyArray<VoiceSessionEvent>): number {
  let first: number | null = null;
  let last: number | null = null;
  for (const e of events) {
    if (!('ts' in e) || typeof e.ts !== 'number') continue;
    if (first === null) first = e.ts;
    last = e.ts;
  }
  if (first === null || last === null) return 0;
  return last - first;
}
