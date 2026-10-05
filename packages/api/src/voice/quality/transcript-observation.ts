/**
 * #1602 — adapt a STORED production call into the shapes the existing Layer 2
 * graders consume, so they are imported unchanged rather than re-implemented.
 *
 * The graders (`ai/voice-quality/graders/*`) read an `Observation` (the event
 * log + session-end classification) and a `VoiceQualityScript` (the caller's
 * turns + expectations). A production call has neither: it has the
 * `voice_sessions.transcript` lines (`"caller: …"` / `"agent: …"`, appended by
 * the telephony adapters in speaking order) and, when the mid-call transcript
 * persistence captured them, per-turn timing markers. This module derives:
 *
 *   - script turns: one per caller utterance, `expected: {}` (production has
 *     no ground truth; the disposition judge then "judges for
 *     reasonableness", and perceived completion reads the whole transcript);
 *   - `speech_outbound` events: the agent's reply to each caller turn —
 *     consecutive agent lines joined — so the graders read what the caller
 *     HEARD. A turn the agent never answered has no event and renders as
 *     `<response not captured>` to the judge, exactly as in the harness;
 *   - `perTurnLatencyMs`: caller-turn marker → the next agent-turn marker,
 *     for floor #3 (`noHang`) where timings exist.
 *
 * Transcripts only — never audio. Agent lines before the first caller turn
 * (the greeting + disclosure) are not a reply to anything and are dropped
 * from turn pairing.
 */
import type { Observation } from '../../ai/voice-quality/observation';
import type { VoiceQualityScript } from '../../ai/voice-quality/schema';
import type { VoiceSessionEvent } from '../../ai/agents/customer-calling/voice-session-store';
import type { GradableVoiceSession } from './voice-session-grade-store';

export interface TranscriptTurn {
  caller: string;
  /** Joined agent reply, or null when the agent never answered the turn. */
  agent: string | null;
}

const LINE_RE = /^(caller|agent)\s*:\s*(.*)$/i;

/** Pair each caller utterance with the agent lines that followed it. */
export function pairTranscriptTurns(transcript: readonly string[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const raw of transcript) {
    const match = LINE_RE.exec(raw.trim());
    if (!match) continue;
    const speaker = match[1].toLowerCase();
    const text = match[2].trim();
    if (speaker === 'caller') {
      if (current && text.length > 0 && current.agent === null) {
        // Two caller lines with no agent reply between them: one turn.
        current.caller = `${current.caller} ${text}`.trim();
        continue;
      }
      current = { caller: text, agent: null };
      turns.push(current);
    } else if (current && text.length > 0) {
      current.agent = current.agent === null ? text : `${current.agent} ${text}`;
    }
  }
  return turns;
}

/**
 * Per-turn latency from stored markers: each caller marker to the first agent
 * marker after it. A caller turn with no following agent marker counts its
 * wait to the call's end — the same "no reply is a hang" reading the harness
 * observation builder uses.
 */
export function latenciesFromTimings(
  timings: ReadonlyArray<{ speaker: 'caller' | 'agent'; startedAt: Date }>,
  endedAt: Date,
): number[] {
  const ordered = [...timings].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const latencies: number[] = [];
  let pendingCallerTs: number | null = null;
  for (const t of ordered) {
    if (t.speaker === 'caller') {
      if (pendingCallerTs !== null) latencies.push(t.startedAt.getTime() - pendingCallerTs);
      pendingCallerTs = t.startedAt.getTime();
    } else if (pendingCallerTs !== null) {
      latencies.push(t.startedAt.getTime() - pendingCallerTs);
      pendingCallerTs = null;
    }
  }
  if (pendingCallerTs !== null) latencies.push(Math.max(0, endedAt.getTime() - pendingCallerTs));
  return latencies;
}

export interface GraderInputs {
  script: VoiceQualityScript;
  observation: Observation;
  turns: TranscriptTurn[];
}

/** `VoiceQualityScript.id` must match /^[a-z0-9-]+$/; a UUID lowercased does. */
function scriptIdFor(sessionId: string): string {
  return `prod-${sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}

export function buildGraderInputs(
  session: GradableVoiceSession,
  endedAt: Date,
  turnLimit?: number,
): GraderInputs {
  const allTurns = pairTranscriptTurns(session.transcript);
  const turns = turnLimit !== undefined ? allTurns.slice(0, turnLimit) : allTurns;

  const script: VoiceQualityScript = {
    id: scriptIdFor(session.id),
    // Required by the script type; no grader reads it for a production call.
    bucket: '01-happy-lookups',
    fixtures: {
      tenant: {
        timezone: session.timezone,
        // `describeCorpusCall` reads the call moment + zone from here, so the
        // judges grade spoken dates against the real call date.
        businessHours: { timezone: session.timezone, callMomentLocal: session.startedAt.toISOString() },
      },
      customers: [],
    },
    callerId: null,
    callerIdBlocked: false,
    callerIsOwner: false,
    turns: turns.map((t) => ({ caller: t.caller, expected: {}, hangupAfter: false })),
    grading: { appliesFloor: [3], appliesDisposition: [10, 12] },
    layer2Eligible: true,
    layer2Only: false,
  };

  const events: VoiceSessionEvent[] = [];
  turns.forEach((t, turnIndex) => {
    if (t.agent !== null) events.push({ type: 'speech_outbound', transcript: t.agent, turnIndex, ts: 0 });
  });
  const hangup = session.outcome === 'dropped';
  const completedish =
    session.outcome === 'completed' ||
    session.outcome === 'escalated_to_human' ||
    session.outcome === 'callback_required';
  events.push({ type: 'session_terminated', cause: hangup ? 'hangup' : 'completed', ts: 0 });

  const observation: Observation = {
    callId: session.id,
    scriptId: script.id,
    tenantId: session.tenantId,
    events,
    proposals: [],
    customerCountDelta: 0,
    appointmentCountDelta: 0,
    audit: [],
    totalCostCents: 0,
    totalDurationMs: Math.max(0, endedAt.getTime() - session.startedAt.getTime()),
    perTurnLatencyMs: session.turnTimings ? latenciesFromTimings(session.turnTimings, endedAt) : [],
    sessionEndedAs: completedish ? 'completed' : 'terminated',
    hangupOccurred: hangup,
    errors: [],
  };

  return { script, observation, turns };
}
