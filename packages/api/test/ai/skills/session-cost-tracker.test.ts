import {
  SessionCostTracker,
  DEFAULT_TELEPHONY_CAPS,
  DEFAULT_INAPP_CAPS,
  CLASSIFY_TURN_INPUT_TOKEN_BUDGET,
  EXPECTED_MAX_CLASSIFY_TURNS,
  EXPECTED_MAX_INAPP_CLASSIFY_TURNS,
  estimateCostCents,
  estimateCostMicroCents,
} from '../../../src/ai/skills/session-cost-tracker';
import type { SessionCapConfig, SessionCapEvent } from '../../../src/ai/skills/session-cost-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tracker with tight caps so tests stay small. */
function makeTracker(overrides: Partial<SessionCapConfig> = {}): SessionCostTracker {
  return new SessionCostTracker({
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxCostCents: 100,
    ...overrides,
  });
}

function eventTypes(events: SessionCapEvent[]): string[] {
  return events.map((e) => `${e.type}:${e.dimension}`);
}

// ---------------------------------------------------------------------------
// Default caps
// ---------------------------------------------------------------------------

describe('SessionCostTracker — default caps', () => {
  it('DEFAULT_TELEPHONY_CAPS is derived from the per-turn budget (#886)', () => {
    // 9,000 tokens/classify-turn × 8 turns — see the derivation comment on
    // the constants (#902 re-derived the budget from the structural
    // worst-case first turn incl. MAX_PROMPT_ASSETS training assets). The
    // pre-#886 5,000 was smaller than ONE ungated classify turn, so every
    // call escalated on the first sentence.
    expect(DEFAULT_TELEPHONY_CAPS.maxInputTokens).toBe(
      CLASSIFY_TURN_INPUT_TOKEN_BUDGET * EXPECTED_MAX_CLASSIFY_TURNS,
    );
    expect(DEFAULT_TELEPHONY_CAPS.maxInputTokens).toBe(72000);
    expect(DEFAULT_TELEPHONY_CAPS.maxOutputTokens).toBe(1500);
    expect(DEFAULT_TELEPHONY_CAPS.maxCostCents).toBe(40);
    // Cost reconciliation: exhausting the token caps still spends well
    // under the money cap — tokens bind first, cost is the backstop.
    expect(
      estimateCostCents(
        DEFAULT_TELEPHONY_CAPS.maxInputTokens,
        DEFAULT_TELEPHONY_CAPS.maxOutputTokens,
      ),
    ).toBeLessThan(DEFAULT_TELEPHONY_CAPS.maxCostCents);
  });

  it('DEFAULT_INAPP_CAPS is derived from the per-turn budget (#886/#902)', () => {
    // 30-minute trusted 'operator' session (full taxonomy): budget × 10.
    // Pins the ARITHMETIC, not a literal — the in-app cap must move with
    // the documented budget exactly as the telephony cap does (a bare
    // 60,000 here was #902's standards violation: the same product,
    // detached from its derivation).
    expect(DEFAULT_INAPP_CAPS.maxInputTokens).toBe(
      CLASSIFY_TURN_INPUT_TOKEN_BUDGET * EXPECTED_MAX_INAPP_CLASSIFY_TURNS,
    );
    expect(EXPECTED_MAX_INAPP_CLASSIFY_TURNS).toBe(10);
    expect(DEFAULT_INAPP_CAPS.maxOutputTokens).toBe(3000);
    expect(DEFAULT_INAPP_CAPS.maxCostCents).toBe(80);
    expect(
      estimateCostCents(DEFAULT_INAPP_CAPS.maxInputTokens, DEFAULT_INAPP_CAPS.maxOutputTokens),
    ).toBeLessThan(DEFAULT_INAPP_CAPS.maxCostCents);
  });
});

// ---------------------------------------------------------------------------
// No events when under 80%
// ---------------------------------------------------------------------------

describe('SessionCostTracker — no events below 80%', () => {
  it('returns no events when token usage is below 80%', () => {
    const tracker = makeTracker();
    // 79 input tokens / 100 max = 79% — below threshold
    const events = tracker.recordUsage({ inputTokens: 79, outputTokens: 0, costCents: 0 });
    expect(events).toHaveLength(0);
  });

  it('returns no events when cost usage is below 80%', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costCents: 79 });
    expect(events).toHaveLength(0);
  });

  it('isExceeded is false when nothing has been exceeded', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 50, outputTokens: 50, costCents: 50 });
    expect(tracker.isExceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cost_cap_approached fires exactly once at 80% of token cap
// ---------------------------------------------------------------------------

describe('SessionCostTracker — cost_cap_approached for tokens', () => {
  it('fires cost_cap_approached when input tokens reach 80%', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_approached:tokens');
  });

  it('fires cost_cap_approached when output tokens reach 80%', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 0, outputTokens: 80, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_approached:tokens');
  });

  it('fires cost_cap_approached exactly once even across multiple calls', () => {
    const tracker = makeTracker();
    const first = tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 0 });
    expect(eventTypes(first)).toContain('cost_cap_approached:tokens');

    // Second call should NOT re-fire the approached event
    const second = tracker.recordUsage({ inputTokens: 5, outputTokens: 0, costCents: 0 });
    expect(eventTypes(second)).not.toContain('cost_cap_approached:tokens');
  });

  it('includes a remainingPct in the approached event', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 0 });
    const approached = events.find(
      (e): e is Extract<typeof e, { type: 'cost_cap_approached' }> =>
        e.type === 'cost_cap_approached' && e.dimension === 'tokens'
    );
    expect(approached).toBeDefined();
    // 80 / 100 = 0.8 used, so 0.2 remaining
    expect(approached!.remainingPct).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// cost_cap_exceeded fires at 100% of token cap
// ---------------------------------------------------------------------------

describe('SessionCostTracker — cost_cap_exceeded for tokens', () => {
  it('fires cost_cap_exceeded when input tokens reach 100%', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_exceeded:tokens');
  });

  it('fires cost_cap_exceeded when output tokens reach 100%', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 0, outputTokens: 100, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_exceeded:tokens');
  });

  it('fires cost_cap_exceeded exactly once across multiple calls', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    const second = tracker.recordUsage({ inputTokens: 10, outputTokens: 0, costCents: 0 });
    expect(eventTypes(second)).not.toContain('cost_cap_exceeded:tokens');
  });

  it('isExceeded becomes true after token cap exceeded', () => {
    const tracker = makeTracker();
    expect(tracker.isExceeded).toBe(false);
    tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    expect(tracker.isExceeded).toBe(true);
  });

  it('both approached and exceeded fire in same call when jump is large', () => {
    const tracker = makeTracker();
    // Jump straight from 0 to 100 — should get both events in one call
    const events = tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_approached:tokens');
    expect(eventTypes(events)).toContain('cost_cap_exceeded:tokens');
  });
});

// ---------------------------------------------------------------------------
// cost_cap_exceeded fires at 100% of cost cap
// ---------------------------------------------------------------------------

describe('SessionCostTracker — cost_cap_exceeded for cost', () => {
  it('fires cost_cap_exceeded when cost reaches 100%', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costCents: 100 });
    expect(eventTypes(events)).toContain('cost_cap_exceeded:cost');
  });

  it('fires cost_cap_approached at 80% of cost cap', () => {
    const tracker = makeTracker();
    const events = tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costCents: 80 });
    expect(eventTypes(events)).toContain('cost_cap_approached:cost');
    expect(eventTypes(events)).not.toContain('cost_cap_exceeded:cost');
  });

  it('isExceeded becomes true after cost cap exceeded', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costCents: 100 });
    expect(tracker.isExceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Both tokens and cost caps can fire in same session (different dimensions)
// ---------------------------------------------------------------------------

describe('SessionCostTracker — multiple dimensions in same session', () => {
  it('both tokens and cost exceeded events can fire in same session', () => {
    const tracker = makeTracker();
    // Hit token cap
    const first = tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    expect(eventTypes(first)).toContain('cost_cap_exceeded:tokens');

    // Hit cost cap in the next call
    const second = tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costCents: 100 });
    expect(eventTypes(second)).toContain('cost_cap_exceeded:cost');
  });

  it('both dimensions can be approached in a single session', () => {
    const tracker = makeTracker();
    const tokenEvents = tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 80 });
    expect(eventTypes(tokenEvents)).toContain('cost_cap_approached:tokens');
    expect(eventTypes(tokenEvents)).toContain('cost_cap_approached:cost');
  });
});

// ---------------------------------------------------------------------------
// reset() clears all state and re-arms all caps
// ---------------------------------------------------------------------------

describe('SessionCostTracker — reset()', () => {
  it('clears totals after reset', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 50, outputTokens: 50, costCents: 50 });
    tracker.reset();
    expect(tracker.totals).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
  });

  it('isExceeded is false after reset', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    expect(tracker.isExceeded).toBe(true);
    tracker.reset();
    expect(tracker.isExceeded).toBe(false);
  });

  it('re-arms cost_cap_approached after reset', () => {
    const tracker = makeTracker();
    // Fire approached, then reset
    tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 0 });
    tracker.reset();

    // Should fire again after reset
    const events = tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_approached:tokens');
  });

  it('re-arms cost_cap_exceeded after reset', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    tracker.reset();

    const events = tracker.recordUsage({ inputTokens: 100, outputTokens: 0, costCents: 0 });
    expect(eventTypes(events)).toContain('cost_cap_exceeded:tokens');
  });
});

// ---------------------------------------------------------------------------
// totals snapshot
// ---------------------------------------------------------------------------

describe('SessionCostTracker — totals', () => {
  it('accumulates totals across multiple recordUsage calls', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 10, outputTokens: 5, costCents: 3 });
    tracker.recordUsage({ inputTokens: 7, outputTokens: 2, costCents: 1 });
    expect(tracker.totals).toEqual({ inputTokens: 17, outputTokens: 7, costCents: 4 });
  });
});

// ---------------------------------------------------------------------------
// Micro-cent accumulation (PR #975 review finding 4; U6 / #895)
//
// Sub-cent completions (a sentiment or vulnerability-grader call is ~9,000
// micro-cents on a cheap model) used to be rounded to integer cents BEFORE
// they reached the tracker, so every one of them recorded 0 and a long call
// never moved `totals.costCents` for its own classifier spend. The tracker
// now accumulates micro-cents and derives the integer-cent total, carrying
// the sub-cent remainder across calls.
// ---------------------------------------------------------------------------

describe('SessionCostTracker — micro-cent accumulation', () => {
  const SUB_CENT_CALL = { inputTokens: 600, outputTokens: 10, costMicroCents: 9_000 } as const;

  it('120 calls of 9,000 micro-cents sum to 1 integer cent, not 0', () => {
    const tracker = makeTracker();
    for (let i = 0; i < 120; i++) tracker.recordUsage(SUB_CENT_CALL);
    // 120 × 9,000 = 1,080,000 µ¢ = 1.08¢ → 1 (remainder carried, not dropped)
    expect(tracker.totals.costCents).toBe(1);
    expect(Number.isInteger(tracker.totals.costCents)).toBe(true);
  });

  it('carries the sub-cent remainder across calls instead of dropping it', () => {
    const tracker = makeTracker();
    // 3 × 400,000 = 1,200,000 µ¢ → 1¢ with 200,000 µ¢ carried…
    for (let i = 0; i < 3; i++) {
      tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costMicroCents: 400_000 });
    }
    expect(tracker.totals.costCents).toBe(1);
    // …so two more 400,000 µ¢ calls (2,000,000 total) land exactly on 2¢.
    tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costMicroCents: 400_000 });
    tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costMicroCents: 400_000 });
    expect(tracker.totals.costCents).toBe(2);
  });

  it('integer-cent callers and micro-cent callers accumulate into one total', () => {
    const tracker = makeTracker();
    tracker.recordUsage({ inputTokens: 10, outputTokens: 5, costCents: 3 });
    tracker.recordUsage({ inputTokens: 600, outputTokens: 10, costMicroCents: 500_000 });
    tracker.recordUsage({ inputTokens: 600, outputTokens: 10, costMicroCents: 500_000 });
    expect(tracker.totals).toEqual({ inputTokens: 1210, outputTokens: 25, costCents: 4 });
  });

  it('cap events fire on the accumulated micro-cent total', () => {
    const tracker = makeTracker({ maxCostCents: 2 });
    const fired: string[] = [];
    // 2¢ cap = 2,000,000 µ¢. 80% = 1,600,000 µ¢ → call 178 (1,602,000);
    // 100% → call 223 (2,007,000).
    let approachedAt: number | undefined;
    let exceededAt: number | undefined;
    for (let i = 1; i <= 230; i++) {
      const events = tracker.recordUsage(SUB_CENT_CALL);
      for (const type of eventTypes(events)) {
        fired.push(type);
        if (type === 'cost_cap_approached:cost') approachedAt = i;
        if (type === 'cost_cap_exceeded:cost') exceededAt = i;
      }
    }
    expect(approachedAt).toBe(178);
    expect(exceededAt).toBe(223);
    expect(fired.filter((t) => t === 'cost_cap_approached:cost')).toHaveLength(1);
    expect(fired.filter((t) => t === 'cost_cap_exceeded:cost')).toHaveLength(1);
    expect(tracker.isExceeded).toBe(true);
    expect(tracker.totals.costCents).toBe(2);
  });

  it('reset() clears the micro-cent accumulation too', () => {
    const tracker = makeTracker();
    for (let i = 0; i < 120; i++) tracker.recordUsage(SUB_CENT_CALL);
    expect(tracker.totals.costCents).toBe(1);
    tracker.reset();
    expect(tracker.totals.costCents).toBe(0);
    // A fresh remainder — the pre-reset 80,000 µ¢ carry must not survive.
    for (let i = 0; i < 110; i++) tracker.recordUsage(SUB_CENT_CALL);
    expect(tracker.totals.costCents).toBe(0);
  });

  it('estimateCostMicroCents keeps sub-cent estimates non-zero; estimateCostCents still rounds to whole cents', () => {
    // 600 × 300 µ¢ + 10 × 1,500 µ¢ = 180,000 + 15,000
    expect(estimateCostMicroCents(600, 10)).toBe(195_000);
    expect(estimateCostCents(600, 10)).toBe(0);
    // 10,000 × 300 + 2,000 × 1,500 = 6,000,000 µ¢ = 6¢ on both paths.
    expect(estimateCostMicroCents(10_000, 2_000)).toBe(6_000_000);
    expect(estimateCostCents(10_000, 2_000)).toBe(6);
    expect(estimateCostMicroCents(-5, -5)).toBe(0);
  });
});
