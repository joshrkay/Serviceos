export interface SessionCapConfig {
  maxInputTokens: number;   // default: 72000 — see the derivation on DEFAULT_TELEPHONY_CAPS
  maxOutputTokens: number;  // default: 1500
  maxCostCents: number;     // default: 40 ($0.40)
  maxDurationMs: number;    // default: 15 * 60 * 1000 (15 min telephony)
}

export type SessionCapEvent =
  | { type: 'cost_cap_approached'; remainingPct: number; dimension: 'tokens' | 'cost' | 'duration' }
  | { type: 'cost_cap_exceeded'; dimension: 'tokens' | 'cost' | 'duration' };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number; // caller computes this from token prices
}

/**
 * #886 — the documented per-turn basis for `maxInputTokens`. The caps below
 * are DERIVED (budget × expected turns), never picked by feel.
 *
 * The input caps are CUMULATIVE per session (recordUsage sums every turn),
 * so a cap must be sized as per-turn-budget × expected-turns. The old
 * `maxInputTokens: 5000` (unchanged since 2026-04-30) predates the taxonomy
 * growth waves and had become smaller than ONE classify turn (~15.2k tokens
 * ungated) — every inbound call fired `cost_cap_exceeded` at inputPct ~3.0
 * on the caller's first sentence, while sitting ~130× tighter than its own
 * `maxCostCents: 40` sibling (≈133k input tokens at $3/MTok).
 *
 * CLASSIFY_TURN_INPUT_TOKEN_BUDGET: worst STRUCTURAL first turn on a gated
 * surface — 'caller' profile prompt + customer-protection section + the full
 * canonical HVAC pack (vertical block + intake questions + objection
 * scripts) + MAX_PROMPT_ASSETS (5) tenant training assets saturating the
 * prompt builder's own truncation caps (training-assets.ts: title 160 /
 * guidance 1,000 / labels 300 chars each) + a long utterance ≈ 7,004 tokens
 * (chars/4, measured 2026-08-28, #902 audit — every term above is bounded by
 * code, so this is a ceiling, not a sample). × 1.15 safety margin ≈ 8,055,
 * rounded up to 9,000 so the regression pin
 * (test/ai/orchestration/classifier-prompt-budget.test.ts: real assembled
 * first turn < 85% of budget = 7,650) holds with real slack (~8.4%) instead
 * of ~1%.
 *
 * EXPECTED_MAX_CLASSIFY_TURNS: a 15-minute telephony session that classifies
 * on every exchange runs ~8 LLM turns (greeting/confirm/lookup turns are
 * cheaper than the budget, so 8 full-budget turns is conservative).
 */
export const CLASSIFY_TURN_INPUT_TOKEN_BUDGET = 9000;
export const EXPECTED_MAX_CLASSIFY_TURNS = 8;

/**
 * In-app sessions run 30 minutes (twice telephony) but lean on the screen
 * for readbacks, so fewer exchanges classify: 10 full-budget turns, not 16.
 * Same derivation discipline as EXPECTED_MAX_CLASSIFY_TURNS — the in-app cap
 * below is budget × turns, never a bare number (#902; the old literal 60,000
 * was exactly this product at the previous 6,000 budget, but written as a
 * magic number it silently detached from the derivation).
 */
export const EXPECTED_MAX_INAPP_CLASSIFY_TURNS = 10;

/**
 * Telephony (15 min): input = 9,000 × 8 = 72,000.
 *
 * maxCostCents reconciliation: estimateCostCents(72_000, 1_500) =
 * 21.6 + 2.25 ≈ 24¢ — a session that exhausts the whole input cap still
 * spends well under the 40¢ money cap, so tokens (the operational
 * dimension) bind before cost (the financial backstop), in that order by
 * design. The ungated 'operator'/'owner_line' prompt (~15.2k tokens/turn)
 * fits ~4 classify turns under this cap — acceptable for an owner burning
 * budget on their own line; further owner-prompt conditioning is a
 * follow-up (#887).
 */
export const DEFAULT_TELEPHONY_CAPS: SessionCapConfig = {
  maxInputTokens: CLASSIFY_TURN_INPUT_TOKEN_BUDGET * EXPECTED_MAX_CLASSIFY_TURNS,
  maxOutputTokens: 1500,
  maxCostCents: 40,
  maxDurationMs: 15 * 60 * 1000,
};

/**
 * In-app (30 min, trusted 'operator' surface — full taxonomy):
 * input = 9,000 × 10 = 90,000.
 * estimateCostCents(90_000, 3_000) = 27 + 4.5 ≈ 32¢ < the 80¢ money cap.
 * The pre-#886 10,000 was under ONE full-taxonomy classify turn (~14.5k
 * tokens) — same class of bug as telephony's 5,000.
 */
export const DEFAULT_INAPP_CAPS: SessionCapConfig = {
  maxInputTokens: CLASSIFY_TURN_INPUT_TOKEN_BUDGET * EXPECTED_MAX_INAPP_CLASSIFY_TURNS,
  maxOutputTokens: 3000,
  maxCostCents: 80,
  maxDurationMs: 30 * 60 * 1000,
};

const WARN_THRESHOLD = 0.8;

/**
 * Conservative blended cost estimate in integer cents from token counts.
 *
 * Wave 8B doesn't yet have per-model pricing wired through the gateway
 * response, so we use a single rate that approximates Sonnet-class
 * pricing ($3/MTok input, $15/MTok output) as a directional signal —
 * enough to fire the per-session cost cap when usage grows. Replace
 * with provider-reported pricing once the gateway threads it through.
 *
 * Returns 0 (not a fractional value) when usage is below 1 cent so
 * the cap math still works on integers.
 */
export function estimateCostCents(input: number, output: number): number {
  const inputCents = (input * 0.0003);  // $3 per 1M = 0.0003¢/token
  const outputCents = (output * 0.0015); // $15 per 1M = 0.0015¢/token
  return Math.max(0, Math.round(inputCents + outputCents));
}

type CapDimension = 'tokens' | 'cost' | 'duration';

export class SessionCostTracker {
  private readonly _config: SessionCapConfig;

  private _inputTokens = 0;
  private _outputTokens = 0;
  private _costCents = 0;

  // Track which warning / exceeded events have already been emitted so we
  // never fire the same event twice for the same dimension in one session.
  private _warnedDimensions = new Set<CapDimension>();
  private _exceededDimensions = new Set<CapDimension>();

  constructor(config: Partial<SessionCapConfig> = {}) {
    this._config = { ...DEFAULT_TELEPHONY_CAPS, ...config };
  }

  /** Record usage from one LLM turn. Returns any cap events triggered. */
  recordUsage(usage: TokenUsage): SessionCapEvent[] {
    this._inputTokens += usage.inputTokens;
    this._outputTokens += usage.outputTokens;
    this._costCents += usage.costCents;

    const events: SessionCapEvent[] = [];

    // Tokens — treat input and output separately against their own caps but
    // report under the single 'tokens' dimension (the spec defines one
    // dimension for both).  A dimension is considered exceeded when EITHER
    // individual limit is breached; approached when EITHER reaches 80%.
    const inputPct = this._inputTokens / this._config.maxInputTokens;
    const outputPct = this._outputTokens / this._config.maxOutputTokens;
    const tokensPct = Math.max(inputPct, outputPct);

    events.push(...this._evaluate('tokens', tokensPct));

    // Cost
    const costPct = this._costCents / this._config.maxCostCents;
    events.push(...this._evaluate('cost', costPct));

    return events;
  }

  /** Record elapsed time. Returns any cap events triggered. */
  checkDuration(elapsedMs: number): SessionCapEvent[] {
    const pct = elapsedMs / this._config.maxDurationMs;
    return this._evaluate('duration', pct);
  }

  /** Current totals snapshot. */
  get totals(): { inputTokens: number; outputTokens: number; costCents: number } {
    return {
      inputTokens: this._inputTokens,
      outputTokens: this._outputTokens,
      costCents: this._costCents,
    };
  }

  /** True if any hard cap has been exceeded. */
  get isExceeded(): boolean {
    return this._exceededDimensions.size > 0;
  }

  /** Per-session total cost cap (cents) this tracker was configured with. */
  get costCapCents(): number {
    return this._config.maxCostCents;
  }

  reset(): void {
    this._inputTokens = 0;
    this._outputTokens = 0;
    this._costCents = 0;
    this._warnedDimensions.clear();
    this._exceededDimensions.clear();
  }

  /**
   * Evaluate a single dimension against its usage fraction and emit any
   * newly-triggered cap events. Deduplicates: each event fires at most once
   * per dimension per session lifetime (reset() re-arms all caps).
   */
  private _evaluate(dimension: CapDimension, pct: number): SessionCapEvent[] {
    const events: SessionCapEvent[] = [];

    if (pct >= WARN_THRESHOLD && !this._warnedDimensions.has(dimension)) {
      this._warnedDimensions.add(dimension);
      events.push({
        type: 'cost_cap_approached',
        remainingPct: Math.max(0, 1 - pct),
        dimension,
      });
    }

    if (pct >= 1 && !this._exceededDimensions.has(dimension)) {
      this._exceededDimensions.add(dimension);
      events.push({ type: 'cost_cap_exceeded', dimension });
    }

    return events;
  }
}
