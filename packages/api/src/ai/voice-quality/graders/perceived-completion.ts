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
import { parseJsonResponse } from './parse-json-response';
import { describeCorpusCall } from '../layer2-world';

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
  /** #1331 — the agent's line per script turn, exactly as the judge read it. */
  agentTurns: string[];
}

const VerdictSchema = z.object({
  perceivedSatisfaction: z.enum(['good', 'acceptable', 'poor']),
  rationale: z.string().max(500),
  abandonmentRisk: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

const JUDGE_SYSTEM = `You are a strict but fair evaluator of a voice agent's interaction with a caller.
Given the full caller transcript and the agent's spoken responses (Whisper-recovered),
determine whether the caller experienced this as a successful interaction.

How this product works (grade against THIS contract, not an imagined one):
- The agent never carries out a change during the call. For any request that
  changes something (book, cancel, update, refund, message, ...) it first reads
  the request back ("Just to confirm — ... Is that right?") and, on the caller's
  yes, the change is drafted for human approval: a person on the business's team
  reviews it before anything happens. The business owner hears that it is in
  their approvals; a customer hears that the team will confirm.
- So a readback followed by "drafted / in your approvals / the team will
  confirm" IS the caller getting what they asked for. Do not mark a call poor
  because the change was not applied live, or because the agent asked the
  readback question.
- It is still a failure when the agent drafted the wrong thing, lost the
  request, gave wrong information, or left the caller without an answer.
- The "Expected outcome" given with the transcript is the product's
  specification of the right outcome for this call. A reply that matches its
  expected answer gave the caller what they came for — even where it corrects
  the literal request (an existing customer who asks to "sign up" is told they
  are already set up and offered what they can do next). Grade satisfaction
  against that outcome, not against the literal words of the request; it is
  still poor if the reply is wrong, lost, or leaves the caller nowhere to go.
- The agent never speaks a year. Read every date it says against the call
  date given above; do not infer a year from your own calendar.

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
    return { passed: verdictPasses(cached), verdict: cached, agentTurns: agentLines(input.observation, input.script) };
  }

  const agentTurns = agentLines(input.observation, input.script);
  const transcript = buildTranscriptSummary(input.observation, input.script, agentTurns);
  const expected = describeExpected(input.script);
  // #1331 — persona + the corpus call date, the same context the
  // criterion-12 judge gets, so a spoken date is judged on the right calendar.
  const caller = describeCorpusCall(input.script);
  const userPrompt = `${caller}\n\nFull call transcript:\n${transcript}\n\nExpected outcome (the product's specification for this call; a reply matching it is the caller getting what they came for):\n${expected}`;

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
    raw = parseJsonResponse(response.content);
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

  return { passed: verdictPasses(verdict), verdict, agentTurns };
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
 * The agent's line for each script turn, read off `speech_outbound`
 * (later-emitted overrides earlier for a duplicated turn). A turn with no
 * captured speech — Layer 1 pre-emit fallback, or a Layer 2 turn whose
 * Whisper recovery came back empty — is `<response not captured>`, so a
 * silent / un-transcribable turn is a signal to the judge, never elided.
 */
function agentLines(observation: Observation, script: VoiceQualityScript): string[] {
  const agentByTurn = new Map<number, string>();
  for (const e of observation.events) {
    if (e.type === 'speech_outbound') agentByTurn.set(e.turnIndex, e.transcript);
  }
  return script.turns.map((_, i) => {
    const agent = agentByTurn.get(i);
    return agent !== undefined && agent.length > 0 ? agent : '<response not captured>';
  });
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
function buildTranscriptSummary(
  observation: Observation,
  script: VoiceQualityScript,
  agentTurns: string[],
): string {
  const lines: string[] = [];
  for (let i = 0; i < script.turns.length; i++) {
    lines.push(`Caller: ${script.turns[i].caller}`);
    lines.push(`Agent: ${agentTurns[i]}`);
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

/**
 * #1613 — the classification is a LABEL for the request (what the caller
 * literally asked); the expected reply is the OUTCOME owed to them. Rendered
 * as "intent=create_customer, answer matches …" the judge read the label as
 * the outcome and failed the correct "you're already set up" reply.
 */
function describeExpected(script: VoiceQualityScript): string {
  return script.turns
    .map((t, i) => {
      const intent = t.expected.intent ?? 'any';
      const also = t.expected.alsoAcceptedIntents?.length
        ? ` (also accepted: ${t.expected.alsoAcceptedIntents.join(', ')})`
        : '';
      const escalates = t.expected.escalates === undefined ? 'any' : String(t.expected.escalates);
      const reply = t.expected.spokenAnswerMatches
        ? `; the right reply matches: "${t.expected.spokenAnswerMatches}"`
        : '';
      return `Turn ${i + 1}: the request is classified as ${intent}${also}; escalates: ${escalates}${reply}`;
    })
    .join('\n');
}
