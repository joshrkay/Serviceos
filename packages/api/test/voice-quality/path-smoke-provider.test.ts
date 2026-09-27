/**
 * Real-LLM path smoke — provider selection + cost projection seams.
 *
 * The smoke must exercise the SAME provider production uses (Railway prod/dev:
 * AI_PROVIDER_BASE_URL=https://api.openai.com/v1 + AI_PROVIDER_API_KEY, tier
 * models gpt-4o-mini / gpt-4o). ANTHROPIC_API_KEY is only an explicit
 * fallback. No network in these tests.
 */
import { describe, it, expect } from 'vitest';
import { LLMGateway, type LLMResponse } from '../../src/ai/gateway/gateway';
import {
  withPathSmokeSpendTracking,
  describePathSmokeProvider,
  pathSmokeCallCents,
  projectPathSmokeCents,
  selectPathSmokeProvider,
} from '../../src/ai/voice-quality/path-smoke';

/** Railway prod/dev AI env, as of 2026-09. */
const PROD_AI_ENV = {
  AI_PROVIDER_API_KEY: 'sk-prod-test',
  AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
  AI_DEFAULT_MODEL: 'gpt-4o-mini',
  AI_LIGHTWEIGHT_MODEL: 'gpt-4o-mini',
  AI_STANDARD_MODEL: 'gpt-4o-mini',
  AI_COMPLEX_MODEL: 'gpt-4o',
};

describe('selectPathSmokeProvider', () => {
  it('uses the production provider config when AI_PROVIDER_API_KEY is set, even if ANTHROPIC_API_KEY is too', () => {
    const sel = selectPathSmokeProvider({ ...PROD_AI_ENV, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(sel).toEqual({
      kind: 'production',
      keySource: 'AI_PROVIDER_API_KEY',
      apiKey: 'sk-prod-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
  });

  it('routes classify_intent to the lightweight-tier model when all per-tier models are set (factory precedence)', () => {
    const sel = selectPathSmokeProvider({
      AI_PROVIDER_API_KEY: 'k',
      AI_DEFAULT_MODEL: 'default-model',
      AI_LIGHTWEIGHT_MODEL: 'light-model',
      AI_STANDARD_MODEL: 'standard-model',
      AI_COMPLEX_MODEL: 'complex-model',
    });
    expect(sel?.model).toBe('light-model');
  });

  it('uses AI_DEFAULT_MODEL for classify when the per-tier set is incomplete, and the OpenAI base URL by default', () => {
    const sel = selectPathSmokeProvider({
      AI_PROVIDER_API_KEY: 'k',
      AI_DEFAULT_MODEL: 'default-model',
      AI_LIGHTWEIGHT_MODEL: 'light-model',
    });
    expect(sel).toMatchObject({ model: 'default-model', baseUrl: 'https://api.openai.com/v1' });
  });

  it('falls back to the Anthropic harness gateway (Haiku 4.5) only when no AI_PROVIDER_API_KEY is set', () => {
    const sel = selectPathSmokeProvider({ ANTHROPIC_API_KEY: 'sk-ant-test', AI_PROVIDER_API_KEY: '' });
    expect(sel).toEqual({
      kind: 'anthropic-fallback',
      keySource: 'ANTHROPIC_API_KEY',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com/v1/',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('returns null when neither key is set (the CLI then exits 2, never a silent pass)', () => {
    expect(selectPathSmokeProvider({ AI_PROVIDER_API_KEY: '  ', ANTHROPIC_API_KEY: '' })).toBeNull();
  });
});

describe('projectPathSmokeCents', () => {
  // OpenAI list price, gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output.
  it('prices gpt-4o-mini at OpenAI rates, not Haiku rates', () => {
    // 1 call: 9,999 system-prompt tokens + a 4-char utterance (1 token) =
    // 10,000 input tokens → 0.15¢; 250 output tokens → 0.015¢.
    const cents = projectPathSmokeCents({
      model: 'gpt-4o-mini',
      utterances: ['abcd'],
      systemPromptTokens: 9_999,
      outputTokensPerCall: 250,
    });
    expect(cents).toBeCloseTo(0.165, 6);
  });
});

describe('pathSmokeCallCents', () => {
  it('prices the dated snapshot id OpenAI returns (gpt-4o-mini-2024-07-18) at gpt-4o-mini rates, not gpt-4o', () => {
    // 1,000,000 input → 15¢ ; 100,000 output → 6¢ (gpt-4o would be 250¢ + 100¢).
    expect(
      pathSmokeCallCents('gpt-4o-mini-2024-07-18', { input: 1_000_000, output: 100_000 }),
    ).toBeCloseTo(21, 6);
  });

  it('returns null for a model with no known price (never a guessed cost)', () => {
    expect(pathSmokeCallCents('mystery-model', { input: 10, output: 10 })).toBeNull();
    expect(
      projectPathSmokeCents({
        model: 'mystery-model',
        utterances: ['hi'],
        systemPromptTokens: 100,
        outputTokensPerCall: 10,
      }),
    ).toBeNull();
  });
});

describe('describePathSmokeProvider', () => {
  it('names the production host + model and the key source, never the key', () => {
    const line = describePathSmokeProvider(selectPathSmokeProvider(PROD_AI_ENV)!);
    expect(line).toContain('production');
    expect(line).toContain('api.openai.com');
    expect(line).toContain('gpt-4o-mini');
    expect(line).toContain('AI_PROVIDER_API_KEY');
    expect(line).not.toContain('sk-prod-test');
  });

  it('flags the Anthropic fallback as NOT the production provider', () => {
    const line = describePathSmokeProvider(
      selectPathSmokeProvider({ ANTHROPIC_API_KEY: 'sk-ant-test' })!,
    );
    expect(line).toContain('ANTHROPIC_API_KEY');
    expect(line).toContain('claude-haiku-4-5-20251001');
    expect(line).toMatch(/NOT the production provider/);
    expect(line).not.toContain('sk-ant-test');
  });
});

describe('withPathSmokeSpendTracking', () => {
  function fakeGateway(response: Partial<LLMResponse>): LLMGateway {
    return {
      complete: async () => ({
        content: '{}',
        model: 'unused',
        provider: 'fake',
        latencyMs: 1,
        ...response,
      }),
    } as unknown as LLMGateway;
  }

  it("adds each call's cents, priced by the model that served it", async () => {
    let spent = 0;
    const tracked = withPathSmokeSpendTracking(
      fakeGateway({
        model: 'gpt-4o-mini-2024-07-18',
        tokenUsage: { input: 1_000_000, output: 100_000, total: 1_100_000 },
      }),
      { fallbackModel: 'gpt-4o', addCents: (n) => (spent += n) },
    );
    const res = await tracked.complete({ taskType: 'classify_intent', messages: [] });
    expect(res.model).toBe('gpt-4o-mini-2024-07-18');
    expect(spent).toBeCloseTo(21, 6);
    expect(tracked).toBeInstanceOf(LLMGateway);
  });

  it('prices at the selected model when the served model id is unpriced', async () => {
    let spent = 0;
    const tracked = withPathSmokeSpendTracking(
      fakeGateway({ model: 'mystery', tokenUsage: { input: 1_000_000, output: 0, total: 1_000_000 } }),
      { fallbackModel: 'gpt-4o', addCents: (n) => (spent += n) },
    );
    await tracked.complete({ taskType: 'classify_intent', messages: [] });
    expect(spent).toBeCloseTo(250, 6);
  });
});
