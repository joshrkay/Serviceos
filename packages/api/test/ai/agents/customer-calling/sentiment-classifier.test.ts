import { describe, it, expect, vi } from 'vitest';
import { classifyTurnSentiment } from '../../../../src/ai/agents/customer-calling/sentiment-classifier';
import { SessionCostTracker } from '../../../../src/ai/skills/session-cost-tracker';

describe('classifyTurnSentiment', () => {
  it('returns frustrationScore from the LLM response', async () => {
    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({ frustrationScore: 0.85, reasonHint: 'angry tone' }),
      })),
    };
    const result = await classifyTurnSentiment(
      { transcript: 'this is so frustrating', priorTurns: [], intent: 'unknown' },
      { llm: llm as never },
    );
    expect(result.frustrationScore).toBeCloseTo(0.85);
    expect(result.reasonHint).toBe('angry tone');
  });

  it('returns frustrationScore=0 when LLM response is malformed', async () => {
    const llm = { complete: vi.fn(async () => ({ text: 'not json' })) };
    const result = await classifyTurnSentiment(
      { transcript: 'hi', priorTurns: [], intent: 'unknown' },
      { llm: llm as never },
    );
    expect(result.frustrationScore).toBe(0);
  });

  it('returns frustrationScore=0 when LLM call throws', async () => {
    const llm = { complete: vi.fn(async () => { throw new Error('rate limit'); }) };
    const result = await classifyTurnSentiment(
      { transcript: 'hi', priorTurns: [], intent: 'unknown' },
      { llm: llm as never },
    );
    expect(result.frustrationScore).toBe(0);
  });

  it('respects cost cap — returns early without calling LLM when budget exceeded', async () => {
    const llm = { complete: vi.fn() };
    const tracker = { totals: { costCents: 30 } };
    const result = await classifyTurnSentiment(
      { transcript: 'hi', priorTurns: [], intent: 'unknown' },
      {
        llm: llm as never,
        costTracker: tracker as never,
        sessionCostCapCents: 40,
        maxSentimentBudgetRatio: 0.25,
      },
    );
    expect(llm.complete).not.toHaveBeenCalled();
    expect(result.frustrationScore).toBe(0);
  });
});

// #895 — the classifier read `costTracker.totals.costCents` for its budget
// guard but never recorded its OWN completion, so its spend was invisible
// to the per-session cap it was guarding against.
describe('#895 — classifyTurnSentiment records its completion usage on the cost tracker', () => {
  const INPUT = { transcript: 'this is taking forever', priorTurns: [], intent: 'unknown', tenantId: 't1' };
  const SENTIMENT_JSON = JSON.stringify({ frustrationScore: 0.4, reasonHint: null });

  function tracker(costCents = 0) {
    return { totals: { costCents }, recordUsage: vi.fn(() => []) };
  }

  it('records the provider token counts, priced by the completion model id', async () => {
    const llm = {
      complete: vi.fn(async (_args: { prompt: string }) => ({
        text: SENTIMENT_JSON,
        // claude-haiku-4-5: 100¢/M input, 500¢/M output → 2¢ + 2¢ = 4¢
        // = 4,000,000 µ¢, passed raw (PR #975 finding 4: never pre-rounded).
        tokenUsage: { input: 20_000, output: 4_000 },
        model: 'claude-haiku-4-5-20251001',
      })),
    };
    const costTracker = tracker();
    const result = await classifyTurnSentiment(INPUT, {
      llm,
      costTracker,
      sessionCostCapCents: 40,
      maxSentimentBudgetRatio: 0.8,
    });
    expect(result.frustrationScore).toBeCloseTo(0.4);
    expect(costTracker.recordUsage).toHaveBeenCalledTimes(1);
    expect(costTracker.recordUsage).toHaveBeenCalledWith({
      inputTokens: 20_000,
      outputTokens: 4_000,
      costMicroCents: 4_000_000,
    });
  });

  it('falls back to the directional estimate for a model with no known price', async () => {
    const llm = {
      complete: vi.fn(async (_args: { prompt: string }) => ({
        text: SENTIMENT_JSON,
        // estimateCostMicroCents: 10_000 × 300 µ¢ + 2_000 × 1,500 µ¢ = 6,000,000 µ¢ (6¢).
        tokenUsage: { input: 10_000, output: 2_000 },
        model: 'mock',
      })),
    };
    const costTracker = tracker();
    await classifyTurnSentiment(INPUT, { llm, costTracker });
    expect(costTracker.recordUsage).toHaveBeenCalledWith({
      inputTokens: 10_000,
      outputTokens: 2_000,
      costMicroCents: 6_000_000,
    });
  });

  // PR #975 review finding 4 — a typical per-turn sentiment call is
  // sub-cent (≈600 input / 10 output tokens). Rounding each call to integer
  // cents before recording it stored 0 every time, so a long call's
  // classifier spend never moved `totals.costCents` and the budget-ratio
  // guard stayed blind to its own cost.
  it('records a sub-cent completion as non-zero micro-cents', async () => {
    const llm = {
      complete: vi.fn(async (_args: { prompt: string }) => ({
        text: SENTIMENT_JSON,
        // claude-haiku-4-5: 600 × 100 µ¢ + 10 × 500 µ¢ = 65,000 µ¢ (0.065¢).
        tokenUsage: { input: 600, output: 10 },
        model: 'claude-haiku-4-5',
      })),
    };
    const costTracker = tracker();
    await classifyTurnSentiment(INPUT, { llm, costTracker });
    expect(costTracker.recordUsage).toHaveBeenCalledWith({
      inputTokens: 600,
      outputTokens: 10,
      costMicroCents: 65_000,
    });
  });

  it('a real SessionCostTracker accumulates many sub-cent classifications into whole cents', async () => {
    const llm = {
      complete: vi.fn(async (_args: { prompt: string }) => ({
        text: SENTIMENT_JSON,
        tokenUsage: { input: 600, output: 10 },
        model: 'claude-haiku-4-5',
      })),
    };
    const costTracker = new SessionCostTracker({ maxCostCents: 40 });
    const deps = { llm, costTracker, sessionCostCapCents: 40, maxSentimentBudgetRatio: 0.8 };
    for (let i = 0; i < 20; i++) await classifyTurnSentiment(INPUT, deps);
    // 20 × 65,000 = 1,300,000 µ¢ → 1¢ (was 0 when each call pre-rounded).
    expect(costTracker.totals.costCents).toBe(1);
    expect(llm.complete).toHaveBeenCalledTimes(20);
  });

  it('records nothing when the completion carries no token usage or the call throws', async () => {
    const noUsage = tracker();
    await classifyTurnSentiment(INPUT, {
      llm: { complete: vi.fn(async () => ({ text: SENTIMENT_JSON })) },
      costTracker: noUsage,
    });
    expect(noUsage.recordUsage).not.toHaveBeenCalled();

    const thrown = tracker();
    await classifyTurnSentiment(INPUT, {
      llm: {
        complete: vi.fn(async () => {
          throw new Error('rate limit');
        }),
      },
      costTracker: thrown,
    });
    expect(thrown.recordUsage).not.toHaveBeenCalled();
  });

  it('budget ratio >= 0.8 → no LLM call and nothing recorded (existing guard preserved)', async () => {
    const llm = {
      complete: vi.fn(async (_args: { prompt: string }) => ({
        text: SENTIMENT_JSON,
        tokenUsage: { input: 20_000, output: 4_000 },
        model: 'claude-haiku-4-5',
      })),
    };
    const costTracker = tracker(32);
    const result = await classifyTurnSentiment(INPUT, {
      llm,
      costTracker,
      sessionCostCapCents: 40,
      maxSentimentBudgetRatio: 0.8,
    });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(costTracker.recordUsage).not.toHaveBeenCalled();
    expect(result.frustrationScore).toBe(0);
  });
});
