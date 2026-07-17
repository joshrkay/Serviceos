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
import {
  DEFAULT_COST_CAP_CENTS,
  LIVE_INTENT_TARGET,
  LIVE_SLOT_TARGET,
  checkCostCap,
  evaluateGate,
  parseMaxUtterances,
  projectCallCents,
  projectRunCents,
  resolveCostCapCents,
  resolveLiveApiKey,
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

describe('voice-eval live plumbing — credential resolution', () => {
  it('returns null when no key is present (fail-fast trigger)', () => {
    expect(resolveLiveApiKey({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveLiveApiKey({ ANTHROPIC_API_KEY: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('prefers ANTHROPIC_API_KEY, falls back to AI_PROVIDER_API_KEY', () => {
    expect(resolveLiveApiKey({ ANTHROPIC_API_KEY: 'a', AI_PROVIDER_API_KEY: 'b' } as NodeJS.ProcessEnv))
      .toEqual({ key: 'a', source: 'ANTHROPIC_API_KEY' });
    expect(resolveLiveApiKey({ AI_PROVIDER_API_KEY: 'b' } as NodeJS.ProcessEnv))
      .toEqual({ key: 'b', source: 'AI_PROVIDER_API_KEY' });
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
  it('projectCallCents grows with utterance length and is positive', () => {
    const short = projectCallCents(10);
    const long = projectCallCents(1000);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });

  it('projectRunCents is the sum over utterances', () => {
    const us = ['aaaa', 'bbbbbbbb'];
    expect(projectRunCents(us)).toBeCloseTo(projectCallCents(4) + projectCallCents(8), 6);
  });

  it('checkCostCap flags over-cap vs within-cap correctly', () => {
    const many = Array.from({ length: 1000 }, () => 'x'.repeat(200));
    const over = checkCostCap(many, 100);
    expect(over.withinCap).toBe(false);
    expect(over.projectedCents).toBeGreaterThan(100);

    const within = checkCostCap(['short'], 100000);
    expect(within.withinCap).toBe(true);
  });

  it('resolveCostCapCents defaults conservatively and honors valid overrides', () => {
    expect(resolveCostCapCents({} as NodeJS.ProcessEnv)).toBe(DEFAULT_COST_CAP_CENTS);
    expect(resolveCostCapCents({ VOICE_EVAL_COST_CAP_CENTS: '250' } as NodeJS.ProcessEnv)).toBe(250);
    expect(resolveCostCapCents({ VOICE_EVAL_COST_CAP_CENTS: 'nope' } as NodeJS.ProcessEnv)).toBe(DEFAULT_COST_CAP_CENTS);
    expect(resolveCostCapCents({ VOICE_EVAL_COST_CAP_CENTS: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_COST_CAP_CENTS);
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
