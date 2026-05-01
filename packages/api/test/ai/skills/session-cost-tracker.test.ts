import {
  SessionCostTracker,
  DEFAULT_TELEPHONY_CAPS,
  DEFAULT_INAPP_CAPS,
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
    maxDurationMs: 1000,
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
  it('DEFAULT_TELEPHONY_CAPS has the expected values', () => {
    expect(DEFAULT_TELEPHONY_CAPS.maxInputTokens).toBe(5000);
    expect(DEFAULT_TELEPHONY_CAPS.maxOutputTokens).toBe(1500);
    expect(DEFAULT_TELEPHONY_CAPS.maxCostCents).toBe(40);
    expect(DEFAULT_TELEPHONY_CAPS.maxDurationMs).toBe(15 * 60 * 1000);
  });

  it('DEFAULT_INAPP_CAPS has the expected values', () => {
    expect(DEFAULT_INAPP_CAPS.maxInputTokens).toBe(10000);
    expect(DEFAULT_INAPP_CAPS.maxOutputTokens).toBe(3000);
    expect(DEFAULT_INAPP_CAPS.maxCostCents).toBe(80);
    expect(DEFAULT_INAPP_CAPS.maxDurationMs).toBe(30 * 60 * 1000);
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

  it('returns no events when duration is below 80%', () => {
    const tracker = makeTracker();
    const events = tracker.checkDuration(799); // 799/1000 = 79.9%
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

  it('all three dimensions can be approached in a single session', () => {
    const tracker = makeTracker();
    const tokenEvents = tracker.recordUsage({ inputTokens: 80, outputTokens: 0, costCents: 80 });
    expect(eventTypes(tokenEvents)).toContain('cost_cap_approached:tokens');
    expect(eventTypes(tokenEvents)).toContain('cost_cap_approached:cost');

    const durationEvents = tracker.checkDuration(800);
    expect(eventTypes(durationEvents)).toContain('cost_cap_approached:duration');
  });
});

// ---------------------------------------------------------------------------
// Duration check
// ---------------------------------------------------------------------------

describe('SessionCostTracker — checkDuration', () => {
  it('fires cost_cap_approached at 80% of maxDurationMs', () => {
    const tracker = makeTracker(); // maxDurationMs: 1000
    const events = tracker.checkDuration(800); // 80%
    expect(eventTypes(events)).toContain('cost_cap_approached:duration');
  });

  it('fires cost_cap_exceeded at 100% of maxDurationMs', () => {
    const tracker = makeTracker();
    const events = tracker.checkDuration(1000);
    expect(eventTypes(events)).toContain('cost_cap_exceeded:duration');
  });

  it('fires both approached and exceeded when elapsedMs jumps past both thresholds', () => {
    const tracker = makeTracker();
    const events = tracker.checkDuration(1001); // beyond 100%
    expect(eventTypes(events)).toContain('cost_cap_approached:duration');
    expect(eventTypes(events)).toContain('cost_cap_exceeded:duration');
  });

  it('does not re-fire duration events on subsequent checks', () => {
    const tracker = makeTracker();
    tracker.checkDuration(1000);
    const second = tracker.checkDuration(2000);
    expect(eventTypes(second)).toHaveLength(0);
  });

  it('isExceeded becomes true after duration exceeded', () => {
    const tracker = makeTracker();
    tracker.checkDuration(1000);
    expect(tracker.isExceeded).toBe(true);
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

  it('re-arms duration cap after reset', () => {
    const tracker = makeTracker();
    tracker.checkDuration(1000);
    tracker.reset();

    const events = tracker.checkDuration(1000);
    expect(eventTypes(events)).toContain('cost_cap_exceeded:duration');
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
