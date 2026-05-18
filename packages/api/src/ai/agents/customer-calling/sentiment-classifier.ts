/**
 * Per-turn LLM sentiment classifier. Async fire-and-forget — called
 * AFTER the FSM dispatch so it never blocks the audio path. If the
 * returned frustrationScore >= threshold, the caller is expected to
 * dispatch a `frustration_detected` event back into the FSM out-of-
 * band; the FSM treats it identically to the keyword path.
 *
 * Cost cap: if the cumulative session cost has already consumed
 * `maxSentimentBudgetRatio` of `sessionCostCapCents`, skip the LLM
 * call (returns score=0) to protect tenant budgets.
 */

export interface SentimentInput {
  transcript: string;
  priorTurns: ReadonlyArray<{ role: 'caller' | 'ai'; text: string }>;
  intent: string;
}

export interface SentimentDeps {
  llm: { complete(args: { prompt: string }): Promise<{ text: string }> };
  costTracker?: { totals: { costCents: number } };
  sessionCostCapCents?: number;
  maxSentimentBudgetRatio?: number;
}

export interface SentimentResult {
  frustrationScore: number;
  reasonHint?: string;
}

const SYSTEM_PROMPT = `You are a sentiment classifier for an AI calling agent.
Given the caller's latest utterance and a few prior turns, return a JSON object:
{
  "frustrationScore": <number 0..1>,
  "reasonHint": <short string or null>
}
0 = perfectly neutral or positive. 1 = explicitly furious / about to hang up.
Calibrate around 0.5 = mildly impatient.
Respond ONLY with valid JSON, no prose.`;

export async function classifyTurnSentiment(
  input: SentimentInput,
  deps: SentimentDeps,
): Promise<SentimentResult> {
  // Cost cap guard.
  if (
    deps.costTracker &&
    deps.sessionCostCapCents != null &&
    deps.maxSentimentBudgetRatio != null
  ) {
    const cap = deps.sessionCostCapCents;
    if (cap <= 0) {
      // Zero or negative cap means no budget at all — skip LLM call.
      return { frustrationScore: 0 };
    }
    const costCents = deps.costTracker.totals.costCents ?? 0;
    const ratio = costCents / cap;
    if (ratio >= deps.maxSentimentBudgetRatio) {
      return { frustrationScore: 0 };
    }
  }

  const priorSummary = input.priorTurns
    .slice(-4)
    .map((t) => `${t.role}: ${t.text}`)
    .join('\n');
  const prompt = `${SYSTEM_PROMPT}\n\nIntent: ${input.intent}\n\nPrior turns:\n${priorSummary}\n\nLatest caller utterance:\n${input.transcript}\n\nJSON:`;

  let raw: string;
  try {
    const res = await deps.llm.complete({ prompt });
    raw = res.text;
  } catch {
    return { frustrationScore: 0 };
  }

  try {
    const parsed = JSON.parse(raw.trim()) as { frustrationScore?: number; reasonHint?: string | null };
    const score = typeof parsed.frustrationScore === 'number' ? parsed.frustrationScore : 0;
    const clamped = Math.max(0, Math.min(1, score));
    return {
      frustrationScore: clamped,
      reasonHint: typeof parsed.reasonHint === 'string' ? parsed.reasonHint : undefined,
    };
  } catch {
    return { frustrationScore: 0 };
  }
}
