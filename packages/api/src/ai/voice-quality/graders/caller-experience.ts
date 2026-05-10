/**
 * VQ2-009 — Mechanical caller-experience grader.
 *
 * Applies hard latency / duration thresholds to per-call audio timings
 * captured by the VQ2-004 helpers. The grader is a pure function: given
 * an `Observation` + the originating `VoiceQualityScript` + (optionally)
 * a thresholds bag, it returns pass/fail per metric and a flat list of
 * failed-metric tags so the runner can attach them to a report row.
 *
 * Three metrics are evaluated:
 *   - `ttfa`        — P95 of `ttfaPerTurn` ≤ 800ms
 *   - `lookupSpeak` — P95 of `lookupToSpeakLatency` ≤ 2000ms
 *   - `duration`    — only on happy-path buckets (01/02/03), the total
 *                     wall-clock call duration ≤ 90s
 *
 * "No measurement = no failure": if a latency array is empty (the call
 * never produced a transcript turn or never executed a lookup), the
 * corresponding metric trivially passes. This avoids penalizing scripts
 * that legitimately have no lookups (e.g., out-of-scope buckets).
 *
 * Non-happy-path buckets (04+) are exempt from the duration cap because
 * identity-edge / compliance-edge / adversarial scenarios routinely
 * take longer by design — we don't want to confuse a thorough handling
 * of a hard scenario with a hung or stuck call.
 */
import {
  ttfaPerTurn,
  lookupToSpeakLatency,
  totalCallDurationMs,
} from '../audio/audio-timings';
import type { Observation } from '../observation';
import type { VoiceQualityScript } from '../schema';
import type { LLMGateway } from '../../gateway/gateway';

export interface CallerExperienceThresholds {
  /** P95 cap on per-turn TTFA. Default 800ms (spec §6.2). */
  ttfaP95MaxMs: number;
  /** P95 cap on lookup→speak latency. Default 2000ms (spec §6.2). */
  lookupP95MaxMs: number;
  /** Total-duration cap for buckets 01/02/03 only. Default 90s (spec §6.2). */
  happyPathMaxMs: number;
}

export const DEFAULT_CALLER_EXPERIENCE_THRESHOLDS: CallerExperienceThresholds = {
  ttfaP95MaxMs: 800,
  lookupP95MaxMs: 2000,
  happyPathMaxMs: 90_000,
};

export interface CallerExperienceResult {
  /** Computed P95 of per-turn TTFA values (0 when no turns recorded). */
  ttfaP95Ms: number;
  /** Computed P95 of lookup→speak latencies (0 when no lookups recorded). */
  lookupP95Ms: number;
  /** Total wall-clock duration of the call from event-bus timestamps. */
  totalDurationMs: number;
  passes: {
    ttfa: boolean;
    lookupSpeak: boolean;
    duration: boolean;
  };
  /** Stable enumeration of failed metric tags. Empty when all passed. */
  failedMetrics: Array<'ttfa' | 'lookupSpeak' | 'duration'>;
}

/**
 * Buckets that count as "happy path" for the duration cap. Edge buckets
 * (identity, compliance, hangup, out-of-scope, ambiguity, concurrency,
 * adversarial) are exempt because they legitimately run longer.
 */
const HAPPY_PATH_BUCKETS = new Set<string>([
  '01-happy-lookups',
  '02-happy-booker',
  '03-lead-capture',
]);

/**
 * Pure function: grades caller-experience metrics from an Observation.
 * Does no I/O. The latency arrays come from `audio-timings.ts`; if any
 * of them is empty, that metric trivially passes.
 */
export function gradeCallerExperience(
  observation: Observation,
  script: VoiceQualityScript,
  thresholds: CallerExperienceThresholds = DEFAULT_CALLER_EXPERIENCE_THRESHOLDS,
): CallerExperienceResult {
  const ttfas = ttfaPerTurn(observation.events);
  const lookupLatencies = lookupToSpeakLatency(observation.events);
  const totalMs = totalCallDurationMs(observation.events);

  const ttfaP95 = percentile(ttfas, 95);
  const lookupP95 = percentile(lookupLatencies, 95);
  const isHappyPath = HAPPY_PATH_BUCKETS.has(script.bucket);

  const passes = {
    ttfa: ttfas.length === 0 || ttfaP95 <= thresholds.ttfaP95MaxMs,
    lookupSpeak:
      lookupLatencies.length === 0 || lookupP95 <= thresholds.lookupP95MaxMs,
    duration: !isHappyPath || totalMs <= thresholds.happyPathMaxMs,
  };

  const failedMetrics: CallerExperienceResult['failedMetrics'] = [];
  if (!passes.ttfa) failedMetrics.push('ttfa');
  if (!passes.lookupSpeak) failedMetrics.push('lookupSpeak');
  if (!passes.duration) failedMetrics.push('duration');

  return {
    ttfaP95Ms: ttfaP95,
    lookupP95Ms: lookupP95,
    totalDurationMs: totalMs,
    passes,
    failedMetrics,
  };
}

/**
 * Nearest-rank percentile, matching the convention used by the VQ-023
 * report aggregator. Conventions:
 *   - Empty array → 0 (caller treats this as "no measurement").
 *   - Single-sample → that sample (avoids index 0 vs. n-1 ambiguity).
 *   - Otherwise sorted ascending; index = floor(p/100 * (n-1)).
 */
function percentile(samples: ReadonlyArray<number>, p: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0];
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

/* -------------------------------------------------------------------------- *
 * VQ2-011 — Reprompt + recovery grader
 * -------------------------------------------------------------------------- *
 *
 * Lives alongside `gradeCallerExperience` (VQ2-009) because reprompts are
 * the same family of caller-facing UX metric — but unlike the mechanical
 * latency grader, this one needs an LLM judge to classify each agent turn
 * as a reprompt or as advancing the call.
 *
 * Strategy: one judge call per turn, bounded to PARALLELISM=5 in flight,
 * so a 20-turn script makes 20 judge calls but never more than 5 at a
 * time. The judge prompt is a fixed prefix (cache-friendly) plus the
 * single agent utterance per call.
 *
 * Reprompt ratio: count(reprompts) / total turns. Threshold ≤ 0.10.
 * Recovery turns: counted from the FIRST reprompt to the FIRST
 * subsequent non-reprompt that advances the call. If the call never
 * recovers (every subsequent turn is also a reprompt), recovery equals
 * the number of turns from first-reprompt+1 to end-of-call. Threshold ≤ 2.
 *
 * v1 limitation (mirrors VQ-022/disposition-llm.ts and VQ2-010): the
 * voice agent does not yet emit a `speech_outbound` event, so we cannot
 * read the agent's actual utterance off the bus. We use the script's
 * `expected.spokenAnswerMatches` as a v1 stand-in. VQ2-021 will swap in
 * the real Whisper-recovered transcript with no API change.
 *
 * Conservative fallback: if the judge returns malformed JSON we treat
 * the turn as NOT a reprompt. Reasoning: a noisy classifier producing
 * spurious failures is worse than missing one reprompt.
 */

export const REPROMPT_RATIO_MAX = 0.1;
export const RECOVERY_MAX_TURNS = 2;

const REPROMPT_JUDGE_PARALLELISM = 5;

export interface RepromptDetectionInput {
  observation: Observation;
  script: VoiceQualityScript;
  gateway: LLMGateway;
}

export interface RepromptResult {
  totalTurns: number;
  repromptCount: number;
  repromptRatio: number;
  recoveryTurns: number;
  perTurnReprompts: boolean[];
  passes: {
    repromptRatio: boolean;
    recovery: boolean;
  };
}

const REPROMPT_JUDGE_SYSTEM_PROMPT = `Given an agent's spoken response in a voice call, classify it as a reprompt or not.

A reprompt is when the agent asks the caller to repeat or clarify something. Examples:
- "Could you say that again?"
- "I didn't catch that. Could you repeat?"
- "Sorry, what did you mean by..."
- A generic clarification like "could you tell me more about" or "what would you like to do"
- Re-asking the same intent slot the prior agent turn already asked for

A NON-reprompt advances the call: it states an answer, gives information,
confirms a slot the caller has just provided, or asks for a NEW slot.

Respond ONLY with valid JSON: { "isReprompt": boolean, "reason": "<= 80 chars" }`;

export async function gradeRepromptAndRecovery(
  input: RepromptDetectionInput,
): Promise<RepromptResult> {
  const turns = input.script.turns;
  if (turns.length === 0) {
    return {
      totalTurns: 0,
      repromptCount: 0,
      repromptRatio: 0,
      recoveryTurns: 0,
      perTurnReprompts: [],
      passes: { repromptRatio: true, recovery: true },
    };
  }

  const perTurnReprompts: boolean[] = [];
  for (let batchStart = 0; batchStart < turns.length; batchStart += REPROMPT_JUDGE_PARALLELISM) {
    const batchSize = Math.min(REPROMPT_JUDGE_PARALLELISM, turns.length - batchStart);
    const batchVerdicts = await Promise.all(
      Array.from({ length: batchSize }, (_, offset) =>
        judgeOneTurn(input, batchStart + offset),
      ),
    );
    perTurnReprompts.push(...batchVerdicts);
  }

  const repromptCount = perTurnReprompts.filter(Boolean).length;
  const repromptRatio = repromptCount / turns.length;
  const recoveryTurns = countRecoveryTurns(perTurnReprompts);

  return {
    totalTurns: turns.length,
    repromptCount,
    repromptRatio,
    recoveryTurns,
    perTurnReprompts,
    passes: {
      repromptRatio: repromptRatio <= REPROMPT_RATIO_MAX,
      recovery: recoveryTurns <= RECOVERY_MAX_TURNS,
    },
  };
}

async function judgeOneTurn(input: RepromptDetectionInput, turnIdx: number): Promise<boolean> {
  // v1 stand-in: VQ2-021 will swap this for the Whisper-recovered transcript.
  const turn = input.script.turns[turnIdx];
  const agentText =
    turn.expected.spokenAnswerMatches ?? `<turn ${turnIdx + 1} response>`;
  const userPrompt = `Agent's spoken response: "${agentText}"`;

  const response = await input.gateway.complete({
    taskType: 'voice_quality_reprompt_judge',
    messages: [
      { role: 'system', content: REPROMPT_JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: 'json',
    temperature: 0,
    metadata: { skill: 'voice_quality_reprompt_judge', turnIdx },
  });

  try {
    const parsed = JSON.parse(response.content);
    return parsed.isReprompt === true;
  } catch {
    return false;
  }
}

/**
 * Count recovery turns: from the first reprompt, count successive turns
 * (inclusive of the next turn) until the first non-reprompt is observed.
 * If no reprompts → 0. If the first reprompt is the very last turn → 0
 * (no remaining turns to recover into). If reprompts run to end-of-call
 * without recovering → the count of remaining turns after the first
 * reprompt (open-ended; bounded by the script length).
 */
function countRecoveryTurns(perTurnReprompts: ReadonlyArray<boolean>): number {
  const firstRepromptIdx = perTurnReprompts.indexOf(true);
  if (firstRepromptIdx === -1) return 0;
  let recovery = 0;
  for (let i = firstRepromptIdx + 1; i < perTurnReprompts.length; i++) {
    recovery += 1;
    if (!perTurnReprompts[i]) return recovery;
  }
  return recovery; // never recovered
}
