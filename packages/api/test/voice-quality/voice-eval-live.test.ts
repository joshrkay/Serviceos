/**
 * Offline unit tests for the voice-eval `--live` plumbing
 * (packages/voice-eval/live-support.ts). Everything here runs with a MOCKED
 * gateway — no real tokens are ever spent. Covers: credential resolution +
 * fail-fast, deterministic sampling, cost-cap projection/abort math, threshold
 * gating, and the intent/slot run loops (incl. the fast-path-hit metric).
 *
 * Lives under packages/api/test so it runs in the same `vitest` invocation as
 * the rest of the voice-quality suite; it imports the eval package by relative
 * path (voice-eval is intentionally not an npm workspace).
 */
import { describe, it, expect } from 'vitest';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import { SYSTEM_PROMPT } from '../../src/ai/orchestration/intent-classifier';
import {
  assertActualCostWithinCap,
  DEFAULT_COST_CAP_CENTS,
  EST_SYSTEM_PROMPT_TOKENS,
  LIVE_INTENT_TARGET,
  LIVE_SLOT_TARGET,
  checkCostCap,
  estimateTokens,
  evaluateGate,
  parseMaxUtterances,
  resolveCostCapCents,
  selectLiveProvider,
  runLiveIntentEval,
  runLiveSlotEval,
  sampleDeterministic,
} from '../../../voice-eval/live-support';

/** Mock gateway returning a fixed classifier JSON with token usage (an LLM call). */
function mockGateway(content: string): LLMGateway {
  return {
    complete: async () => ({
      content,
      model: 'mock',
      provider: 'mock',
      latencyMs: 1,
      tokenUsage: { input: 5, output: 3, total: 8 },
    }),
  } as unknown as LLMGateway;
}

/** Railway prod/dev AI env, as of 2026-09 (what voice-eval-live.yml mirrors). */
const PROD_AI_ENV = {
  AI_PROVIDER_API_KEY: 'sk-prod-test',
  AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
  AI_DEFAULT_MODEL: 'gpt-4o-mini',
  AI_LIGHTWEIGHT_MODEL: 'gpt-4o-mini',
  AI_STANDARD_MODEL: 'gpt-4o-mini',
  AI_COMPLEX_MODEL: 'gpt-4o',
};

describe('voice-eval live plumbing — provider selection', () => {
  it('uses the production provider config (OpenAI, gpt-4o-mini for classify) even when ANTHROPIC_API_KEY is also set', async () => {
    const sel = await selectLiveProvider({ ...PROD_AI_ENV, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(sel).toEqual({
      kind: 'production',
      keySource: 'AI_PROVIDER_API_KEY',
      apiKey: 'sk-prod-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
  });

  it('falls back to the Anthropic harness (Haiku 4.5) only when no AI_PROVIDER_API_KEY is set', async () => {
    const sel = await selectLiveProvider({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(sel).toMatchObject({
      kind: 'anthropic-fallback',
      keySource: 'ANTHROPIC_API_KEY',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('returns null when no key is present (fail-fast trigger, exit 2)', async () => {
    expect(await selectLiveProvider({})).toBeNull();
    expect(await selectLiveProvider({ ANTHROPIC_API_KEY: '  ', AI_PROVIDER_API_KEY: '' })).toBeNull();
  });
});

describe('voice-eval live plumbing — deterministic sampling', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}` }));
  const keyOf = (r: { id: string }): string => r.id;

  it('is stable across input order (same rows every run)', () => {
    const a = sampleDeterministic(rows, keyOf, 10);
    const b = sampleDeterministic([...rows].reverse(), keyOf, 10);
    expect(a.map(keyOf)).toEqual(b.map(keyOf));
  });

  it('respects max and returns all when max >= length', () => {
    expect(sampleDeterministic(rows, keyOf, 7)).toHaveLength(7);
    expect(sampleDeterministic(rows, keyOf, 999)).toHaveLength(50);
    expect(sampleDeterministic(rows, keyOf, undefined)).toHaveLength(50);
  });

  it('a smaller sample is a prefix of a larger one (nested, comparable)', () => {
    const small = sampleDeterministic(rows, keyOf, 5).map(keyOf);
    const big = sampleDeterministic(rows, keyOf, 20).map(keyOf);
    expect(big.slice(0, 5)).toEqual(small);
  });
});

describe('voice-eval live plumbing — --max-utterances parsing', () => {
  it('parses both spellings and rejects invalid', () => {
    expect(parseMaxUtterances(['--max-utterances', '25'])).toBe(25);
    expect(parseMaxUtterances(['--max-utterances=25'])).toBe(25);
    expect(parseMaxUtterances(['--live'])).toBeUndefined();
    expect(parseMaxUtterances(['--max-utterances', '-3'])).toBeUndefined();
    expect(parseMaxUtterances(['--max-utterances', 'abc'])).toBeUndefined();
  });
});

describe('voice-eval live plumbing — cost cap', () => {
  // Expected values are worked by hand from OpenAI / Anthropic-harness list
  // rates, not recomputed the way the code does. One 4-char utterance = 1
  // token, so each call sends EST_SYSTEM_PROMPT_TOKENS (20,000) + 1 input
  // tokens and is assumed to return 250 output tokens.
  it('prices gpt-4o-mini at OpenAI rates ($0.15 / $0.60 per MTok), not Haiku rates', async () => {
    // 20,001 × 15¢/MTok = 0.300015¢ ; 250 × 60¢/MTok = 0.015¢
    const cost = await checkCostCap(['abcd'], 100, 'gpt-4o-mini');
    expect(cost.projectedCents).toBeCloseTo(0.315015, 6);
    expect(cost.withinCap).toBe(true);
  });

  it('prices the Anthropic fallback (claude-haiku-4-5) at the pinned $3 / $15 harness rate', async () => {
    // 20,001 × 300¢/MTok = 6.0003¢ ; 250 × 1500¢/MTok = 0.375¢
    const cost = await checkCostCap(['abcd'], 100, 'claude-haiku-4-5-20251001');
    expect(cost.projectedCents).toBeCloseTo(6.3753, 6);
  });

  it('flags a run whose projection exceeds the cap', async () => {
    // 1,000 gpt-4o-mini calls ≈ 315¢ > 100¢
    const many = Array.from({ length: 1000 }, () => 'abcd');
    const over = await checkCostCap(many, 100, 'gpt-4o-mini');
    expect(over.withinCap).toBe(false);
    expect(over.projectedCents).toBeCloseTo(315.015, 3);
  });

  it('refuses (never within cap) for a model with no known price', async () => {
    const cost = await checkCostCap(['abcd'], 100000, 'mystery-model');
    expect(cost).toEqual({ projectedCents: null, capCents: 100000, withinCap: false });
  });

  it('resolveCostCapCents defaults conservatively and honors valid overrides', () => {
    expect(resolveCostCapCents({} as NodeJS.ProcessEnv)).toBe(DEFAULT_COST_CAP_CENTS);
    expect(resolveCostCapCents({ VOICE_EVAL_COST_CAP_CENTS: '250' } as NodeJS.ProcessEnv)).toBe(250);
    expect(resolveCostCapCents({ VOICE_EVAL_COST_CAP_CENTS: 'nope' } as NodeJS.ProcessEnv)).toBe(DEFAULT_COST_CAP_CENTS);
    expect(resolveCostCapCents({ VOICE_EVAL_COST_CAP_CENTS: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_COST_CAP_CENTS);
  });

  it('actual-cost guard throws as soon as recorded spend exceeds the cap', () => {
    expect(() => assertActualCostWithinCap(100, 100)).not.toThrow();
    expect(() => assertActualCostWithinCap(101, 100)).toThrow(/actual cost.*exceeded cap/);
  });

  // Regression pin for a real PR-review finding: EST_SYSTEM_PROMPT_TOKENS is a
  // hand-set constant, not a measurement, so nothing stopped it drifting below
  // the real classifier prompt as the intent taxonomy grew — a
  // `--max-utterances 200` live run could pass this preflight and still blow
  // past the cost cap once spending started. The live eval path
  // (SYNTHETIC_TENANT_ID, no vertical/plan/owner/extended context — see
  // runLiveIntentEval/runLiveSlotEval defaults) sends exactly the base
  // SYSTEM_PROMPT and nothing else, so comparing against it directly (with a
  // safety margin) is the correct bound. If this fails, the real prompt has
  // outgrown its headroom: bump EST_SYSTEM_PROMPT_TOKENS in live-support.ts,
  // don't loosen the margin here.
  it('EST_SYSTEM_PROMPT_TOKENS stays a safe overestimate of the real classifier system prompt', () => {
    const actualTokens = estimateTokens(SYSTEM_PROMPT);
    const SAFETY_MARGIN = 1.15;
    expect(EST_SYSTEM_PROMPT_TOKENS).toBeGreaterThanOrEqual(Math.ceil(actualTokens * SAFETY_MARGIN));
  });
});

describe('voice-eval live plumbing — threshold gating', () => {
  it('report-only when gate is false (always passes)', () => {
    expect(evaluateGate(0.5, LIVE_INTENT_TARGET, false).pass).toBe(true);
  });
  it('enforces target when gate is true', () => {
    expect(evaluateGate(0.93, LIVE_INTENT_TARGET, true).pass).toBe(true);
    expect(evaluateGate(0.91, LIVE_INTENT_TARGET, true).pass).toBe(false);
    expect(evaluateGate(0.88, LIVE_SLOT_TARGET, true).pass).toBe(true);
    expect(evaluateGate(0.87, LIVE_SLOT_TARGET, true).pass).toBe(false);
  });
});

describe('voice-eval live plumbing — intent run loop (mocked gateway)', () => {
  it('maps classifier output to pairs and counts LLM calls', async () => {
    const gw = mockGateway('{"intentType":"create_invoice","confidence":0.9}');
    const rows = [
      { utterance: 'please bill acme four hundred', intent: 'create_invoice' },
      { utterance: 'random words here', intent: 'draft_estimate' },
    ];
    const res = await runLiveIntentEval(rows, gw);
    expect(res.pairs).toEqual([
      { gold: 'create_invoice', pred: 'create_invoice' },
      { gold: 'draft_estimate', pred: 'create_invoice' },
    ]);
    expect(res.llmCalls).toBe(2);
    expect(res.fastPathHits).toBe(0);
  });

  it('counts a fast-path hit (empty transcript short-circuits before the LLM)', async () => {
    const gw = mockGateway('{"intentType":"create_invoice","confidence":0.9}');
    const rows = [
      { utterance: '', intent: 'unknown' },
      { utterance: 'bill acme', intent: 'create_invoice' },
    ];
    const res = await runLiveIntentEval(rows, gw);
    // Empty transcript never hits the gateway → fast-path; the other does.
    expect(res.fastPathHits).toBe(1);
    expect(res.llmCalls).toBe(1);
  });

  it('stops the intent loop immediately when the post-row budget guard throws', async () => {
    const gw = mockGateway('{"intentType":"unknown","confidence":0.5}');
    let completed = 0;
    await expect(
      runLiveIntentEval(
        [{ utterance: 'one', intent: 'unknown' }, { utterance: 'two', intent: 'unknown' }],
        gw,
        undefined,
        () => {
          completed += 1;
          throw new Error('budget crossed');
        },
      ),
    ).rejects.toThrow('budget crossed');
    expect(completed).toBe(1);
  });
});

describe('voice-eval live plumbing — slot run loop (mocked gateway)', () => {
  it('projects classifier entities onto the four LLM-derived slots', async () => {
    const gw = mockGateway(
      JSON.stringify({
        intentType: 'create_appointment',
        confidence: 0.9,
        extractedEntities: {
          customerName: 'Sarah Johnson',
          dateTimeDescription: 'tomorrow between 8 and 10 AM',
          noteBody: 'AC stopped cooling',
          serviceAddress: '456 Oak Avenue',
        },
      }),
    );
    const examples = [{ transcript: 'my ac is broken', gold: { name: 'Sarah Johnson' } }];
    const res = await runLiveSlotEval(examples, gw);
    expect(res.examples[0].pred).toEqual({
      name: 'Sarah Johnson',
      address: '456 Oak Avenue',
      time_window: 'tomorrow between 8 and 10 AM',
      problem_description: 'AC stopped cooling',
    });
    expect(res.llmCalls).toBe(1);
  });
});
