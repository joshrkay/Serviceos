/**
 * VQ-003 — small constructors for the new VoiceSessionEvent variants.
 *
 * Co-locating these here (rather than scattering ad-hoc object literals
 * at every emit site) keeps the event shape under a single import, so a
 * future shape change is one edit and not a grep-hunt across the
 * adapters. Each constructor stamps `ts: Date.now()` by default so
 * callers don't forget the field.
 *
 * Translation note: the intent classifier exposes its token count as
 * `{ input, output }` (raw provider-reported numbers). The cost tracker
 * — and our event union — uses `{ inputTokens, outputTokens, costCents }`
 * so totals math is uniform across cost_incurred/intent_classified.
 * `intentClassifiedEvent` accepts the classifier's shape for ergonomics
 * and computes `costCents` via the same `estimateCostCents` function the
 * cost tracker uses, so a downstream `cost_incurred` chained off the
 * same usage numbers reports the same delta.
 */
import type { VoiceSessionEvent } from '../agents/customer-calling/voice-session-store';
import { estimateCostCents } from '../skills/session-cost-tracker';
import type { IntentClassification } from '../orchestration/intent-classifier';

/**
 * Build an `intent_classified` event from a classifier result.
 *
 * Accepts either a full `IntentClassification` (will use its
 * `tokenUsage` field if present, falling back to zeroes) or a minimal
 * shape so test fixtures can build events without faking every
 * classifier field.
 */
export function intentClassifiedEvent(
  input: {
    intentType: IntentClassification['intentType'] | string;
    confidence: number;
    tokenUsage?: { input: number; output: number };
  },
  ts: number = Date.now(),
): Extract<VoiceSessionEvent, { type: 'intent_classified' }> {
  const inputTokens = input.tokenUsage?.input ?? 0;
  const outputTokens = input.tokenUsage?.output ?? 0;
  const costCents = estimateCostCents(inputTokens, outputTokens);
  return {
    type: 'intent_classified',
    intentType: String(input.intentType),
    confidence: input.confidence,
    tokenUsage: { inputTokens, outputTokens, costCents },
    ts,
  };
}

export function lookupExecutedEvent(
  skillName: string,
  durationMs: number,
  success: boolean,
  error?: string,
  ts: number = Date.now(),
): Extract<VoiceSessionEvent, { type: 'lookup_executed' }> {
  const event: Extract<VoiceSessionEvent, { type: 'lookup_executed' }> = {
    type: 'lookup_executed',
    skillName,
    durationMs,
    success,
    ts,
  };
  if (error !== undefined) event.error = error;
  return event;
}

export function escalationTriggeredEvent(
  reason: string,
  ts: number = Date.now(),
): Extract<VoiceSessionEvent, { type: 'escalation_triggered' }> {
  return { type: 'escalation_triggered', reason, ts };
}

export function costIncurredEvent(
  deltaCents: number,
  totalCents: number,
  ts: number = Date.now(),
): Extract<VoiceSessionEvent, { type: 'cost_incurred' }> {
  return { type: 'cost_incurred', deltaCents, totalCents, ts };
}

export function sessionTerminatedEvent(
  cause: 'hangup' | 'cost_cap' | 'cap_exceeded' | 'completed',
  ts: number = Date.now(),
): Extract<VoiceSessionEvent, { type: 'session_terminated' }> {
  return { type: 'session_terminated', cause, ts };
}

/**
 * VQ2-004: TTFA-start marker. Emitted by the media-stream adapter the
 * moment the STT provider returns a final transcript for the caller's
 * turn (Whisper-final / Deepgram-final). Pairs with the next
 * `audio_frame_emitted` event to compute time-to-first-audio.
 */
export const transcriptReceivedEvent = (
  opts: { ts?: number } = {},
): Extract<VoiceSessionEvent, { type: 'transcript_received' }> => ({
  type: 'transcript_received',
  ts: opts.ts ?? Date.now(),
});

/**
 * VQ2-004: TTFA-stop marker. Emitted by the media-stream adapter on
 * the FIRST outbound audio chunk of a turn (subsequent chunks in the
 * same turn are suppressed). `byteCount` is the chunk size for sanity
 * — a non-zero count means the WS actually carried audio, not just a
 * mark/heartbeat frame.
 */
export const audioFrameEmittedEvent = (
  opts: { byteCount: number; ts?: number },
): Extract<VoiceSessionEvent, { type: 'audio_frame_emitted' }> => ({
  type: 'audio_frame_emitted',
  byteCount: opts.byteCount,
  ts: opts.ts ?? Date.now(),
});

/** Convenience alias for the new variant constructor below. */
export type SpeechOutboundEvent = Extract<VoiceSessionEvent, { type: 'speech_outbound' }>;

// ─── Section 5 — Filler / Repair telemetry events ────────────────────────────

export interface FillerFiredEvent {
  type: 'filler_fired';
  fillerText: string;
  ts: number;
}

export interface FillerCancelledEvent {
  type: 'filler_cancelled';
  fillerText: string;
  ts: number;
}

export interface RepairTemplateFiredEvent {
  type: 'repair_template_fired';
  trigger: string;
  text: string;
  ts: number;
}

export const fillerFiredEvent = (opts: { fillerText: string; ts?: number }): FillerFiredEvent => ({
  type: 'filler_fired',
  fillerText: opts.fillerText,
  ts: opts.ts ?? Date.now(),
});

export const fillerCancelledEvent = (opts: { fillerText: string; ts?: number }): FillerCancelledEvent => ({
  type: 'filler_cancelled',
  fillerText: opts.fillerText,
  ts: opts.ts ?? Date.now(),
});

export const repairTemplateFiredEvent = (opts: {
  trigger: string;
  text: string;
  ts?: number;
}): RepairTemplateFiredEvent => ({
  type: 'repair_template_fired',
  trigger: opts.trigger,
  text: opts.text,
  ts: opts.ts ?? Date.now(),
});

/**
 * VQ2-followup: emitted by the agent driver after each turn's outbound
 * speech has been finalized. Layer 2 emits the Whisper-recovered
 * transcription of the TTS audio the caller would have heard; Layer 1
 * emits the synthesized confirmation/lookup string the driver was about
 * to "speak". Both consumers (perceived-completion / reprompt graders)
 * read by `turnIndex`, which is the zero-indexed turn position within
 * the script.
 */
export const speechOutboundEvent = (
  opts: { transcript: string; turnIndex: number; ts?: number },
): SpeechOutboundEvent => ({
  type: 'speech_outbound',
  transcript: opts.transcript,
  turnIndex: opts.turnIndex,
  ts: opts.ts ?? Date.now(),
});

// ─── Section 4 — Escalation telemetry events ─────────────────────────────────

export interface EscalationStartedEvent {
  type: 'escalation_started';
  escalationId: string;
  reason: string;
  dispatcherUserId: string;
  tenantId: string;
  ts: number;
}

export interface EscalationSummaryBuiltEvent {
  type: 'escalation_summary_built';
  escalationId: string;
  durationMs: number;
  ts: number;
}

export interface WhisperPlayedEvent {
  type: 'whisper_played';
  escalationId: string;
  dispatcherCallSid: string;
  ts: number;
}

export interface DispatcherAnsweredEvent {
  type: 'dispatcher_answered';
  escalationId: string;
  ts: number;
}

export interface DispatcherNoAnswerEvent {
  type: 'dispatcher_no_answer';
  escalationId: string;
  secondsRing: number;
  ts: number;
}

export interface EscalationOutcomeEvent {
  type: 'escalation_outcome';
  escalationId: string;
  outcome: 'resolved' | 'hung_up' | 'needs_callback';
  ts: number;
}

export const escalationStartedEvent = (opts: {
  escalationId: string;
  reason: string;
  dispatcherUserId: string;
  tenantId: string;
  ts?: number;
}): EscalationStartedEvent => ({
  type: 'escalation_started',
  escalationId: opts.escalationId,
  reason: opts.reason,
  dispatcherUserId: opts.dispatcherUserId,
  tenantId: opts.tenantId,
  ts: opts.ts ?? Date.now(),
});

export const escalationSummaryBuiltEvent = (opts: {
  escalationId: string;
  durationMs: number;
  ts?: number;
}): EscalationSummaryBuiltEvent => ({
  type: 'escalation_summary_built',
  escalationId: opts.escalationId,
  durationMs: opts.durationMs,
  ts: opts.ts ?? Date.now(),
});

export const whisperPlayedEvent = (opts: {
  escalationId: string;
  dispatcherCallSid: string;
  ts?: number;
}): WhisperPlayedEvent => ({
  type: 'whisper_played',
  escalationId: opts.escalationId,
  dispatcherCallSid: opts.dispatcherCallSid,
  ts: opts.ts ?? Date.now(),
});

export const dispatcherAnsweredEvent = (opts: {
  escalationId: string;
  ts?: number;
}): DispatcherAnsweredEvent => ({
  type: 'dispatcher_answered',
  escalationId: opts.escalationId,
  ts: opts.ts ?? Date.now(),
});

export const dispatcherNoAnswerEvent = (opts: {
  escalationId: string;
  secondsRing: number;
  ts?: number;
}): DispatcherNoAnswerEvent => ({
  type: 'dispatcher_no_answer',
  escalationId: opts.escalationId,
  secondsRing: opts.secondsRing,
  ts: opts.ts ?? Date.now(),
});

export const escalationOutcomeEvent = (opts: {
  escalationId: string;
  outcome: EscalationOutcomeEvent['outcome'];
  ts?: number;
}): EscalationOutcomeEvent => ({
  type: 'escalation_outcome',
  escalationId: opts.escalationId,
  outcome: opts.outcome,
  ts: opts.ts ?? Date.now(),
});
