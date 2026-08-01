/**
 * VQ2-010 — Perceived-completion (LLM-judged) grader.
 *
 * Grades **criterion 12** (caller-perceived completion) by reading the FULL
 * call transcript in a single batched judge call per script. Unlike VQ-022
 * (disposition-llm), which makes one judge call per turn for narrow
 * answer-meaning + soft-slot judgments, this grader asks one question of
 * the whole interaction:
 *
 *   "Did the caller experience this call as a successful interaction?"
 *
 * The verdict is a triple: `perceivedSatisfaction` (good/acceptable/poor),
 * a short rationale, and an `abandonmentRisk` score (0/1/2). A script
 * passes when satisfaction is not `poor` AND abandonment risk is not 2.
 * That asymmetry is deliberate: an `acceptable` verdict with `risk=2`
 * (caller likely will not return) is still a soft failure; a `poor`
 * verdict with `risk=0` is also a failure.
 *
 * Concurrency / caching: the 2-of-3 voting harness (VQ2-013) runs each
 * script three times. Because a transcript is fully determined by the
 * observation events + script id, an external cache (passed via `input.cache`)
 * lets the harness re-use a verdict across vote runs whose transcripts
 * happen to be identical — without the grader owning a global module
 * cache (which would leak across test runs and across graders). The
 * cache is keyed by sha256 of `(scriptId, observation.events JSON)`.
 *
 * Transcript synthesis (VQ2-followup): each turn is rendered as
 * `Caller: <utterance>\nAgent: <transcript>` where the agent line is
 * read from `speech_outbound` events on the bus (Layer 2 supplies the
 * Whisper-recovered transcript; Layer 1 supplies the synthesized
 * confirmation/lookup string). A turn without a captured outbound
 * speech event renders as `<response not captured>` so the judge sees
 * the failure rather than the line being elided. A one-line event-type
 * summary is appended so the judge can see hangups, lookups, proposals.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import type { LLMGateway } from '../../gateway/gateway';
import { SYSTEM_TENANT_ID } from '../../gateway/gateway';
import type { Observation } from '../observation';
import type { VoiceQualityScript } from '../schema';

export interface PerceivedCompletionInput {
  observation: Observation;
  script: VoiceQualityScript;
  gateway: LLMGateway;
  /** Optional cost tracker hook. Not called here — cost is tracked at the
   *  gateway-wrapper layer (VQ2-005). Reserved for future direct accounting. */
  costTracker?: { addCents: (n: number) => void };
  /**
   * Optional shared verdict cache. The 2-of-3 voting harness (VQ2-013)
   * passes a single Map across its three runs so identical transcripts
   * across vote runs reuse a single judge call. Keyed by transcript hash.
   */
  cache?: Map<string, PerceivedCompletionVerdict>;
}

export interface PerceivedCompletionVerdict {
  perceivedSatisfaction: 'good' | 'acceptable' | 'poor';
  rationale: string;
  abandonmentRisk: 0 | 1 | 2;
}

export interface PerceivedCompletionResult {
  passed: boolean;
  verdict: PerceivedCompletionVerdict;
}

const VerdictSchema = z.object({
  perceivedSatisfaction: z.enum(['good', 'acceptable', 'poor']),
  rationale: z.string().max(500),
  abandonmentRisk: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

const JUDGE_SYSTEM = `You are a strict but fair evaluator of a voice agent's interaction with a caller.
Given the full caller transcript and the agent's spoken responses (Whisper-recovered),
determine whether the caller experienced this as a successful interaction.

Evaluate:
1. Did the agent address the caller's actual intent (or correctly escalate when out of scope)?
2. Was the agent's information accurate (no hallucinated facts)?
3. Did the conversation feel efficient (no unnecessary loops, redundant clarification)?
4. Was the caller likely satisfied or likely to call back / abandon?

Respond ONLY with valid JSON:
{
  "perceivedSatisfaction": "good" | "acceptable" | "poor",
  "rationale": "string, <= 200 chars, mention the strongest signal driving your verdict",
  "abandonmentRisk": 0 | 1 | 2
}

- "good" = caller got what they wanted with no friction
- "acceptable" = caller got what they wanted, with minor friction (one reprompt, slow response)
- "poor" = caller did NOT get what they wanted, OR had major friction
- abandonmentRisk: 0 = caller would not call back, 1 = might call back later, 2 = caller would not return / would complain`;

export async function gradePerceivedCompletion(
  input: PerceivedCompletionInput,
): Promise<PerceivedCompletionResult> {
  const cacheKey = makeCacheKey(input.script.id, input.observation);

  const cached = input.cache?.get(cacheKey);
  if (cached) {
    return { passed: verdictPasses(cached), verdict: cached };
  }

  const transcript = buildTranscriptSummary(input.observation, input.script);
  const expected = describeExpected(input.script);
  const userPrompt = `Full call transcript:\n${transcript}\n\nExpected behavior (per spec):\n${expected}`;

  const response = await input.gateway.complete({
    taskType: 'voice_quality_perceived_completion',
    // Harness-internal grader with no real tenant; the gateway enforces a
    // top-level tenantId in strict (test/CI) mode, so use the system bucket.
    tenantId: SYSTEM_TENANT_ID,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: 'json',
    temperature: 0,
    metadata: { skill: 'voice_quality_perceived_completion' },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(response.content);
  } catch (err) {
    throw new Error(
      `perceived-completion grader: judge returned invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      } (raw="${response.content.slice(0, 120)}")`,
    );
  }

  const parsed = VerdictSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `perceived-completion grader: judge JSON failed schema validation: ${parsed.error.message}`,
    );
  }
  const verdict: PerceivedCompletionVerdict = parsed.data;

  if (input.cache) input.cache.set(cacheKey, verdict);

  return { passed: verdictPasses(verdict), verdict };
}

function verdictPasses(v: PerceivedCompletionVerdict): boolean {
  return v.perceivedSatisfaction !== 'poor' && v.abandonmentRisk !== 2;
}

function makeCacheKey(scriptId: string, observation: Observation): string {
  // Stable across runs that produce identical events with differing timestamps.
  // Replacer drops `ts` fields (and any future wall-clock fields) so two voting
  // runs whose only difference is per-event millisecond timestamps share a key.
  // Line endings normalized for cross-OS hash stability.
  const eventsJson = JSON
    .stringify(observation.events, (k, v) => (k === 'ts' ? undefined : v))
    .replace(/\r\n/g, '\n');
  const hash = createHash('sha256');
  hash.update(scriptId);
  hash.update(' ');
  hash.update(eventsJson);
  return `${scriptId}:${hash.digest('hex')}`;
}

/**
 * Transcript synthesis. Renders each scripted caller utterance plus
 * the agent's recovered reply (read off `speech_outbound` events on
 * the bus — Layer 2 supplies Whisper-recovered transcripts, Layer 1
 * supplies the synthesized confirmation/lookup string), then appends
 * a one-line summary of the captured event types so the judge has a
 * structural read on what happened.
 *
 * If a turn has no `speech_outbound` event we substitute a "<response
 * not captured>" placeholder; this is a meaningful signal to the
 * judge (the agent failed to speak that turn) rather than silently
 * eliding it.
 */
function buildTranscriptSummary(observation: Observation, script: VoiceQualityScript): string {
  // Index speech_outbound events by turnIndex for O(1) lookup. The
  // driver emits one per turn, but we tolerate duplicates by keeping
  // the most recent (later-emitted overrides earlier).
  const agentByTurn = new Map<number, string>();
  for (const e of observation.events) {
    if (e.type === 'speech_outbound') {
      agentByTurn.set(e.turnIndex, e.transcript);
    }
  }
  const lines: string[] = [];
  for (let i = 0; i < script.turns.length; i++) {
    const turn = script.turns[i];
    lines.push(`Caller: ${turn.caller}`);
    const agent = agentByTurn.get(i);
    if (agent !== undefined && agent.length > 0) {
      lines.push(`Agent: ${agent}`);
    } else {
      // Layer 1 text-mode pre-emit fallback OR a Layer 2 turn whose
      // Whisper recovery returned empty. Surface this to the judge
      // so a silent / un-transcribable turn shows up as a signal.
      lines.push(`Agent: <response not captured>`);
    }
  }
  if (observation.events.length > 0) {
    const eventTypes = observation.events.map((e) => e.type).join(', ');
    lines.push('');
    lines.push(`Event-bus summary (${observation.events.length} events): ${eventTypes}`);
  }
  if (observation.hangupOccurred) {
    lines.push(`Session ended with hangup.`);
  } else {
    lines.push(`Session ended as: ${observation.sessionEndedAs}.`);
  }
  return lines.join('\n');
}

function describeExpected(script: VoiceQualityScript): string {
  return script.turns
    .map((t, i) => {
      const intent = t.expected.intent ?? 'any';
      const escalates = t.expected.escalates === undefined ? 'any' : String(t.expected.escalates);
      const expectedAnswer = t.expected.spokenAnswerMatches
        ? `, answer matches "${t.expected.spokenAnswerMatches}"`
        : '';
      return `Turn ${i + 1}: intent=${intent}, escalates=${escalates}${expectedAnswer}`;
    })
    .join('; ');
}
