import { describe, it, expect, vi } from 'vitest';
import { classifyTurnSentiment } from '../../../../src/ai/agents/customer-calling/sentiment-classifier';

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
