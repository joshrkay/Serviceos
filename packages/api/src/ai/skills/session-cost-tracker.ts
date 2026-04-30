export interface SessionCapConfig {
  maxInputTokens: number;   // default: 5000
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

export const DEFAULT_TELEPHONY_CAPS: SessionCapConfig = {
  maxInputTokens: 5000,
  maxOutputTokens: 1500,
  maxCostCents: 40,
  maxDurationMs: 15 * 60 * 1000,
};

export const DEFAULT_INAPP_CAPS: SessionCapConfig = {
  maxInputTokens: 10000,
  maxOutputTokens: 3000,
  maxCostCents: 80,
  maxDurationMs: 30 * 60 * 1000,
};

const WARN_THRESHOLD = 0.8;

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
