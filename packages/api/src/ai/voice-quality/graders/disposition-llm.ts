/**
 * VQ-022 — Disposition-LLM grader.
 *
 * Grades the two rubric items the structured grader can't:
 *
 *   - **Criterion 12** ("right caller-facing answer"): for lookup turns,
 *     the spoken response must match the ground-truth expected answer in
 *     plain English. Phrasing differences are fine; wrong info / missing
 *     key info / hallucination are failures.
 *   - **Criterion 10 (soft slots)**: notes / reason / description text
 *     on the proposal payload must read reasonably given the caller's
 *     transcript. Hard slots (IDs, enums, datetime) are graded by the
 *     structured grader (VQ-021); this only judges free-text fields.
 *
 * Spoken-answer extraction (#1331): the turn's `speech_outbound`
 * transcript — what the caller heard (Layer 2: Whisper-recovered audio;
 * Layer 1: the text driver's reply). The proposal `summary` is only the
 * fallback when no speech was captured for the turn, and
 * `script.turns[i].expected.spokenAnswerMatches` is only ever the
 * expectation — never the agent's own output (that would tautologically
 * pass the judge). Before #1331 this graded `proposal.summary` (an
 * operator-card title such as "Add material") and skipped every lookup.
 *
 * Concurrency: judge calls run in parallel via a hand-rolled bounded
 * pool (cap 5). Promise.all on a giant array would saturate the LLM
 * provider's connection pool; the bound matches the rate limiter on
 * Haiku in production.
 *
 * Cache: keyed by sha256 of (scriptId, turnIndex, spokenAnswer,
 * expectedAnswer, softSlots-as-stable-JSON). v1 is in-memory only —
 * persistent disk cache (under <observation root>/.judge-cache/) is a
 * follow-up; the API is shaped to allow swapping the implementation
 * without changing call sites. `resetJudgeCache()` is exported for tests
 * and for the harness's per-run reset.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import type { LLMGateway } from '../../gateway/gateway';
import { SYSTEM_TENANT_ID } from '../../gateway/gateway';
import type { Observation } from '../observation';
import type { VoiceQualityScript } from '../schema';
import type { Proposal } from '../../../proposals/proposal';
import { parseJsonResponse } from './parse-json-response';
import { describeCorpusCall } from '../layer2-world';

export interface DispositionLlmInput {
  observation: Observation;
  script: VoiceQualityScript;
  gateway: LLMGateway;
  /** Optional cost tracker hook. Called once per (uncached) judge call. */
  costTracker?: { addCents: (n: number) => void };
}

export interface DispositionLlmTurnDetail {
  turnIndex: number;
  /** The agent's spoken answer for this turn, or null when nothing was captured. */
  spokenAnswer: string | null;
  /** From `script.turns[i].expected.spokenAnswerMatches` when present. */
  expectedAnswer?: string;
  /** Criterion 12 outcome for this turn. */
  answerJudgePass: boolean;
  /** Criterion 10 (soft slots) outcome for this turn. */
  softSlotJudgePass: boolean;
  /** <=500 char rationale from the judge (or skip rationale). */
  judgeRationale: string;
}

export interface DispositionLlmResult {
  passed: boolean;
  /** Subset of [10, 12]. */
  failedCriteria: number[];
  reasons: Record<number, string>;
  perTurnDetail: DispositionLlmTurnDetail[];
}

/** Per-judge-call cents. Haiku is well under 1c per call at our prompt size. */
const JUDGE_CALL_COST_CENTS = 1;
/** Concurrency cap on parallel judge calls. */
const JUDGE_CONCURRENCY = 5;

const JudgeResponseSchema = z.object({
  answerMeaningMatches: z.boolean(),
  softSlotsReasonable: z.boolean(),
  rationale: z.string().max(500),
});
type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

const JUDGE_SYSTEM = `You are a strict but fair evaluator of a voice agent's responses. Given the caller's transcript, the agent's spoken response, and the expected answer (in plain English), determine whether the agent's response conveys the same meaning. Respond ONLY with valid JSON matching the schema:
{
  "answerMeaningMatches": boolean,
  "softSlotsReasonable": boolean,
  "rationale": string  // <= 200 chars
}
You return false for "answerMeaningMatches" only if the agent gave wrong info, missed key info, or hallucinated. Cosmetic differences (phrasing, ordering) are NOT failures.

How this product works (grade against THIS contract, not an imagined one):
- For a request that changes something (book, cancel, update, refund, message, ...) the agent never carries it out during the call. It first reads the request back ("Just to confirm — ... Is that right?"); that read-back IS the right reply to the request turn, and it should restate what the caller asked. On the caller's yes the change is drafted for human review. A turn may complete a meaning set up by the agent's previous line (shown when present): the details the caller just confirmed in the read-back need not be repeated in the drafted reply.
- The business owner (calling their own line) hears that it is "in your approvals waiting for you to review" — for the owner that IS "drafted for review; an operator will confirm", because the owner is the operator. A customer hears that the team will confirm.
- Still wrong: drafting or reading back the wrong thing, saying a draft is incomplete or needs follow-up when the expected answer says it was drafted, claiming the change already happened, or wrong facts.

The agent's line is speech recognition of the audio the caller heard:
- Short pre-recorded fillers played while the agent works ("One moment", "Let me check on that", "Let me see", "Sure thing", "Absolutely", "Got it", "Okay") are not part of the answer — ignore them wherever they appear.
- A word transcribed as a sound-alike of the expected word (e.g. a trade term like "PEX" heard as "pecks") is a transcription artifact, not an agent error. A different value — other digits, another date, address, amount or name — is still wrong.
- The agent says a year only when a date falls outside the call's year. Judge every date it says against the call date given with the turn: a date said without a year is the one nearest that call date (an upcoming visit falls on or after it; a due date may fall just before it). Do not infer a year from your own calendar — a correct day and month is a correct date.`;

/**
 * Soft-field keys that the LLM judge owns on criterion 10. Hard fields
 * (ids, enums, datetimes, money) are graded by VQ-021.
 */
const SOFT_SLOT_KEYS = ['note', 'notes', 'reason', 'description', 'comment', 'comments', 'details', 'reasonText'];

const judgeCache = new Map<string, JudgeResponse>();

/** Test/harness helper — clears the in-memory judge cache. */
export function resetJudgeCache(): void {
  judgeCache.clear();
}

export async function gradeDispositionLlm(
  input: DispositionLlmInput,
): Promise<DispositionLlmResult> {
  const { observation, script, gateway, costTracker } = input;

  // Build per-turn evaluation tasks. Skip turns that have no spoken
  // answer to grade — those return judgePass: true so an absent signal
  // never fails a call (the structured grader catches the "should have
  // produced output" case via criterion 9 / 11).
  const turnTasks: Array<{
    turnIndex: number;
    spokenAnswer: string | null;
    expectedAnswer?: string;
    softSlots: Record<string, unknown>;
    callerTranscript: string;
    previousAgentLine?: string;
  }> = script.turns.map((turn, i) => {
    const proposal = observation.proposals[i] as Proposal | undefined;
    const spokenAnswer = extractSpokenAnswer(observation, i, proposal);
    const softSlots = extractSoftSlots(proposal);
    const previousAgentLine = i > 0 ? spokenLine(observation, i - 1) : undefined;
    return {
      turnIndex: i,
      spokenAnswer,
      ...(previousAgentLine !== undefined ? { previousAgentLine } : {}),
      ...(turn.expected.spokenAnswerMatches !== undefined
        ? { expectedAnswer: turn.expected.spokenAnswerMatches }
        : {}),
      softSlots,
      callerTranscript: turn.caller,
    };
  });

  const callContext = describeCorpusCall(script);

  // Run with bounded concurrency.
  const perTurnDetail: DispositionLlmTurnDetail[] = new Array(turnTasks.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(JUDGE_CONCURRENCY, turnTasks.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= turnTasks.length) return;
          const task = turnTasks[idx];
          perTurnDetail[idx] = await evaluateTurn(
            script.id,
            task.turnIndex,
            task.spokenAnswer,
            task.expectedAnswer,
            task.softSlots,
            task.callerTranscript,
            task.previousAgentLine,
            callContext,
            gateway,
            costTracker,
          );
        }
      })(),
    );
  }
  await Promise.all(workers);

  // Roll up per-turn results into criterion-level pass/fail.
  const failedCriteria: number[] = [];
  const reasons: Record<number, string> = {};
  for (const detail of perTurnDetail) {
    if (!detail.answerJudgePass && !failedCriteria.includes(12)) {
      failedCriteria.push(12);
      reasons[12] = `Turn ${detail.turnIndex}: ${detail.judgeRationale}`;
    }
    if (!detail.softSlotJudgePass && !failedCriteria.includes(10)) {
      failedCriteria.push(10);
      reasons[10] = `Turn ${detail.turnIndex}: ${detail.judgeRationale}`;
    }
  }

  return {
    passed: failedCriteria.length === 0,
    failedCriteria: failedCriteria.sort((a, b) => a - b),
    reasons,
    perTurnDetail,
  };
}

async function evaluateTurn(
  scriptId: string,
  turnIndex: number,
  spokenAnswer: string | null,
  expectedAnswer: string | undefined,
  softSlots: Record<string, unknown>,
  callerTranscript: string,
  previousAgentLine: string | undefined,
  callContext: string,
  gateway: LLMGateway,
  costTracker?: { addCents: (n: number) => void },
): Promise<DispositionLlmTurnDetail> {
  // Missing spoken answer: the v1 fallback path. We pass the turn
  // (judgePass: true) and document why. Once VQ-024 wires real TTS
  // capture this branch becomes a hard failure.
  if (spokenAnswer === null) {
    return {
      turnIndex,
      spokenAnswer: null,
      ...(expectedAnswer !== undefined ? { expectedAnswer } : {}),
      answerJudgePass: true,
      softSlotJudgePass: true,
      judgeRationale: 'no spoken answer captured (v1 fallback; VQ-024 will wire actual transcript capture)',
    };
  }

  const cacheKey = makeCacheKey(scriptId, turnIndex, spokenAnswer, expectedAnswer, softSlots, previousAgentLine);
  let parsed = judgeCache.get(cacheKey);
  if (!parsed) {
    parsed = await callJudge(gateway, {
      callContext,
      callerTranscript,
      spokenAnswer,
      expectedAnswer,
      softSlots,
      ...(previousAgentLine !== undefined ? { previousAgentLine } : {}),
    });
    judgeCache.set(cacheKey, parsed);
    costTracker?.addCents(JUDGE_CALL_COST_CENTS);
  }

  return {
    turnIndex,
    spokenAnswer,
    ...(expectedAnswer !== undefined ? { expectedAnswer } : {}),
    answerJudgePass: parsed.answerMeaningMatches,
    softSlotJudgePass: parsed.softSlotsReasonable,
    judgeRationale: parsed.rationale,
  };
}

interface JudgeUserPromptInput {
  /** #1331 — who is calling + the corpus call date (same for every turn). */
  callContext: string;
  callerTranscript: string;
  /** #1331 — the agent line this caller turn answered (e.g. the read-back). */
  previousAgentLine?: string;
  spokenAnswer: string | null;
  expectedAnswer?: string;
  softSlots: Record<string, unknown>;
}

function buildUserPrompt(input: JudgeUserPromptInput): string {
  const context =
    input.previousAgentLine !== undefined
      ? `Agent's previous line (what the caller was answering): "${input.previousAgentLine}"\n`
      : '';
  return `
${input.callContext}
${context}Caller said: "${input.callerTranscript}"
Agent said: "${input.spokenAnswer ?? '(no spoken response captured)'}"
Expected response should match: "${input.expectedAnswer ?? '(no explicit expectation; just judge for reasonableness)'}"
Soft slots in agent's proposal: ${JSON.stringify(input.softSlots)}
`.trim();
}

async function callJudge(
  gateway: LLMGateway,
  input: JudgeUserPromptInput,
): Promise<JudgeResponse> {
  const response = await gateway.complete({
    taskType: 'voice_quality_judge',
    // voice_quality_judge is tenant-scoped; the gateway enforces a top-level
    // tenantId in strict (test/CI) mode. The judge is a harness-internal grader
    // with no real tenant, so it uses the shared system tenant bucket.
    tenantId: SYSTEM_TENANT_ID,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    responseFormat: 'json',
    temperature: 0,
    metadata: { skill: 'voice_quality_disposition_llm' },
  });

  let raw: unknown;
  try {
    raw = parseJsonResponse(response.content);
  } catch (err) {
    throw new Error(
      `disposition-llm grader: judge returned invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      } (raw="${response.content.slice(0, 120)}")`,
    );
  }

  const parsed = JudgeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `disposition-llm grader: judge JSON failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * The agent's spoken answer for turn `turnIndex`: the `speech_outbound`
 * transcript the driver recorded for that turn (Layer 2: Whisper-recovered
 * from the audio the caller heard; Layer 1: the string the text driver
 * spoke). #1331 — criterion 12 is "right caller-facing answer", so it grades
 * what was SAID. The proposal `summary` is an operator-card title ("Add
 * material"), not a reply; it remains only as the fallback for an
 * observation with no captured speech for the turn. No speech and no
 * proposal → null, and the turn is skipped (see evaluateTurn).
 */
function spokenLine(observation: Observation, turnIndex: number): string | undefined {
  let spoken: string | undefined;
  for (const e of observation.events) {
    if (e.type === 'speech_outbound' && e.turnIndex === turnIndex && e.transcript.trim().length > 0) {
      spoken = e.transcript;
    }
  }
  return spoken;
}

function extractSpokenAnswer(
  observation: Observation,
  turnIndex: number,
  proposal: Proposal | undefined,
): string | null {
  const spoken = spokenLine(observation, turnIndex);
  if (spoken !== undefined) return spoken;
  if (!proposal) return null;
  if (typeof proposal.summary === 'string' && proposal.summary.length > 0) {
    return proposal.summary;
  }
  return null;
}

function extractSoftSlots(proposal: Proposal | undefined): Record<string, unknown> {
  if (!proposal || !proposal.payload || typeof proposal.payload !== 'object') {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const key of SOFT_SLOT_KEYS) {
    if (key in proposal.payload) {
      out[key] = (proposal.payload as Record<string, unknown>)[key];
    }
  }
  return out;
}

function makeCacheKey(
  scriptId: string,
  turnIndex: number,
  spokenAnswer: string,
  expectedAnswer: string | undefined,
  softSlots: Record<string, unknown>,
  previousAgentLine: string | undefined,
): string {
  // Stable JSON: sort soft-slot keys so equivalent payloads produce the
  // same hash regardless of property iteration order.
  const stableSlots = JSON.stringify(softSlots, Object.keys(softSlots).sort());
  const hash = createHash('sha256');
  hash.update(scriptId);
  hash.update(' ');
  hash.update(String(turnIndex));
  hash.update(' ');
  hash.update(spokenAnswer);
  hash.update(' ');
  hash.update(expectedAnswer ?? '');
  hash.update(' ');
  hash.update(stableSlots);
  hash.update(' ');
  hash.update(previousAgentLine ?? '');
  return hash.digest('hex');
}
