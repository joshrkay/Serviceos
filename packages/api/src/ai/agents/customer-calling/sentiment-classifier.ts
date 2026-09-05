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
 *
 * #895: the classifier's OWN completion is recorded on that same tracker
 * (`recordCompletionUsage`), so its spend counts against the cap it guards.
 */
import { estimateCostMicroCents, type TokenUsage } from '../../skills/session-cost-tracker';
import { computeCostMicroCents } from '../../gateway/model-pricing';

/**
 * What the customer-calling classifiers (this one and the vulnerability
 * grader) need from one LLM completion: the gateway's `content`, its
 * provider-reported `tokenUsage` and the resolved `model` id, adapted at the
 * wiring site (app.ts). `tokenUsage` absent → the call is not recorded.
 */
export interface ClassifierCompletion {
  text: string;
  tokenUsage?: { input: number; output: number };
  model?: string;
}

/**
 * The slice of `SessionCostTracker` these classifiers use: `totals` for the
 * budget guard, `recordUsage` so their own spend is visible to that guard.
 */
export interface ClassifierCostTracker {
  totals: { costCents: number };
  recordUsage(usage: TokenUsage): unknown;
}

/**
 * Record one completion's spend on the session tracker. Priced from the
 * gateway's model table when the model id is known; otherwise the same
 * directional estimate the main voice turn records — never a silent zero.
 *
 * Recorded as raw micro-cents, never pre-rounded: a typical per-turn
 * classification is sub-cent (~600 input / 10 output tokens on a cheap
 * model), so rounding each call to integer cents here stored 0 every time
 * and a long call's classifier spend never moved `totals.costCents` — the
 * budget-ratio guard above was blind to its own cost (PR #975 review
 * finding 4). The tracker accumulates micro-cents and derives whole cents.
 */
export function recordCompletionUsage(
  costTracker: ClassifierCostTracker | undefined,
  completion: ClassifierCompletion,
): void {
  if (!costTracker || !completion.tokenUsage) return;
  const { input, output } = completion.tokenUsage;
  const costMicroCents =
    computeCostMicroCents(completion.model, completion.tokenUsage) ??
    estimateCostMicroCents(input, output);
  costTracker.recordUsage({ inputTokens: input, outputTokens: output, costMicroCents });
}

export interface SentimentInput {
  transcript: string;
  priorTurns: ReadonlyArray<{ role: 'caller' | 'ai'; text: string }>;
  intent: string;
  /**
   * Threaded through to the gateway's top-level `tenantId` so the
   * `call_sentiment` task keys the tenant's own concurrency quota / cache
   * bucket rather than falling back to the shared SYSTEM_TENANT_ID bucket
   * (see gateway.ts's `enforceTopLevelTenantId`).
   */
  tenantId: string;
}

export interface SentimentDeps {
  llm: { complete(args: { prompt: string }): Promise<ClassifierCompletion> };
  costTracker?: ClassifierCostTracker;
  sessionCostCapCents?: number;
  maxSentimentBudgetRatio?: number;
}

export interface SentimentResult {
  frustrationScore: number;
  reasonHint?: string;
}

/** Per-session budget inputs the caller threads in to enable the cost-cap guard. */
export type SentimentBudget = Pick<
  SentimentDeps,
  'costTracker' | 'sessionCostCapCents' | 'maxSentimentBudgetRatio'
>;

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
    // #895 — record before parsing: the tokens were bought even if the
    // text turns out to be unparseable.
    recordCompletionUsage(deps.costTracker, res);
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
