import { describe, it, expect, afterEach, vi } from 'vitest';

const ENV_KEY = 'AI_MODEL_PRICING_JSON';

async function freshModule() {
  // AI_MODEL_PRICING_JSON is read once at module load (matches the rest of
  // the gateway's env-derived config, e.g. ai-routing.ts's model env vars),
  // so override tests must reset the module registry to re-evaluate it.
  vi.resetModules();
  return import('../../../src/ai/gateway/model-pricing');
}

describe('model-pricing — integer micro-cent cost accounting', () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
    vi.resetModules();
  });

  describe('resolveModelPricing', () => {
    it('resolves an exact known model family', async () => {
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('claude-sonnet-4-6')).toEqual({
        inputCentsPerMillionTokens: 300,
        outputCentsPerMillionTokens: 1500,
      });
    });

    it('resolves a dated/versioned snapshot id against its base family', async () => {
      const { resolveModelPricing } = await freshModule();
      // The gateway's actual lightweight-tier default (config/ai-routing.ts).
      expect(resolveModelPricing('claude-haiku-4-5-20251001')).toEqual({
        inputCentsPerMillionTokens: 100,
        outputCentsPerMillionTokens: 500,
      });
    });

    it('resolves a provider-namespaced id by its last path segment', async () => {
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('anthropic/claude-opus-4-8')).toEqual({
        inputCentsPerMillionTokens: 500,
        outputCentsPerMillionTokens: 2500,
      });
    });

    it('is case-insensitive', async () => {
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('CLAUDE-SONNET-4-6')).not.toBeNull();
    });

    it('returns null for an unpriced model — never a guessed price', async () => {
      const { resolveModelPricing } = await freshModule();
      // Deliberately excluded from the default table (see model-pricing.ts
      // header): OpenAI models and deprecated Claude models both resolve
      // to null rather than a fabricated rate.
      expect(resolveModelPricing('gpt-4o-mini')).toBeNull();
      expect(resolveModelPricing('claude-opus-4-5')).toBeNull();
      expect(resolveModelPricing('totally-unknown-model')).toBeNull();
    });

    it('returns null for an undefined/empty model id', async () => {
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing(undefined)).toBeNull();
      expect(resolveModelPricing('')).toBeNull();
    });
  });

  describe('computeCostMicroCents — integer correctness', () => {
    it('computes exact micro-cents with no rounding for a typical call', async () => {
      const { computeCostMicroCents } = await freshModule();
      // Haiku 4.5: 100 cents/M input, 500 cents/M output.
      // 500 input tokens * 100 = 50,000 micro-cents; 200 output * 500 = 100,000.
      const cost = computeCostMicroCents('claude-haiku-4-5-20251001', {
        input: 500,
        output: 200,
        total: 700,
      });
      expect(cost).toBe(500 * 100 + 200 * 500);
      expect(cost).toBe(150_000);
    });

    it('never rounds a small (sub-cent) call down to zero', async () => {
      const { computeCostMicroCents } = await freshModule();
      // 1 input token at 100 cents/M = 100 micro-cents — a real, nonzero,
      // exact value. A naive `Math.round(tokens/1e6 * rate)` would floor
      // this whole call to 0 cents.
      const cost = computeCostMicroCents('claude-haiku-4-5-20251001', {
        input: 1,
        output: 0,
        total: 1,
      });
      expect(cost).toBe(100);
      expect(cost).toBeGreaterThan(0);
    });

    it('zero tokens costs exactly zero micro-cents (not null)', async () => {
      const { computeCostMicroCents } = await freshModule();
      const cost = computeCostMicroCents('claude-sonnet-4-6', { input: 0, output: 0, total: 0 });
      expect(cost).toBe(0);
    });

    it('returns null for an unpriced model regardless of token usage', async () => {
      const { computeCostMicroCents } = await freshModule();
      const cost = computeCostMicroCents('gpt-4o-mini', { input: 1000, output: 1000, total: 2000 });
      expect(cost).toBeNull();
    });

    it('returns null when tokenUsage is absent', async () => {
      const { computeCostMicroCents } = await freshModule();
      expect(computeCostMicroCents('claude-sonnet-4-6', undefined)).toBeNull();
    });

    it('treats missing input/output fields as zero rather than NaN', async () => {
      const { computeCostMicroCents } = await freshModule();
      expect(computeCostMicroCents('claude-sonnet-4-6', {})).toBe(0);
    });

    it('sanitizes negative/non-finite token counts to zero (defensive)', async () => {
      const { computeCostMicroCents } = await freshModule();
      const cost = computeCostMicroCents('claude-sonnet-4-6', {
        input: -50,
        output: Number.NaN,
        total: 0,
      });
      expect(cost).toBe(0);
    });

    it('truncates fractional token counts', async () => {
      const { computeCostMicroCents } = await freshModule();
      // 10.9 input tokens -> truncated to 10 -> 10 * 300 = 3000 micro-cents.
      const cost = computeCostMicroCents('claude-sonnet-4-6', { input: 10.9, output: 0 });
      expect(cost).toBe(3000);
    });
  });

  describe('microCentsToCents — the single controlled rounding point', () => {
    it('rounds half up', async () => {
      const { microCentsToCents } = await freshModule();
      expect(microCentsToCents(1_500_000)).toBe(2); // 1.5 cents -> 2
      expect(microCentsToCents(1_499_999)).toBe(1); // 1.499999 cents -> 1
      expect(microCentsToCents(2_000_000)).toBe(2); // exact
    });

    it('a whole-run aggregate rounds once, not per-call', async () => {
      const { computeCostMicroCents, microCentsToCents } = await freshModule();
      // Ten calls at 100 micro-cents each (a sub-cent amount that a naive
      // per-call `Math.round` to cents would floor to 0 every time).
      const perCall = computeCostMicroCents('claude-haiku-4-5-20251001', { input: 1, output: 0 })!;
      const total = perCall * 10;
      expect(total).toBe(1000); // 1000 micro-cents = 0.001 cents... still sub-cent
      // Scale up to a realistic aggregate to show the rounding point matters:
      // summing exact integers first, rounding once at the end, is exact —
      // rounding each call first and summing would lose precision/zero out.
      const manyCalls = Array.from({ length: 10_000 }, () => perCall).reduce((a, b) => a + b, 0);
      expect(manyCalls).toBe(perCall * 10_000);
      expect(microCentsToCents(manyCalls)).toBe(Math.round((perCall * 10_000) / 1_000_000));
    });
  });

  describe('AI_MODEL_PRICING_JSON env override', () => {
    it('merges an override on top of the defaults — overridden model wins', async () => {
      process.env[ENV_KEY] = JSON.stringify({
        'claude-sonnet-4-6': { inputCentsPerMillionTokens: 999, outputCentsPerMillionTokens: 1 },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('claude-sonnet-4-6')).toEqual({
        inputCentsPerMillionTokens: 999,
        outputCentsPerMillionTokens: 1,
      });
    });

    it('leaves other defaults untouched when only one model is overridden', async () => {
      process.env[ENV_KEY] = JSON.stringify({
        'claude-sonnet-4-6': { inputCentsPerMillionTokens: 999, outputCentsPerMillionTokens: 1 },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('claude-haiku-4-5-20251001')).toEqual({
        inputCentsPerMillionTokens: 100,
        outputCentsPerMillionTokens: 500,
      });
    });

    it('adds a brand-new model not in the default table (e.g. gpt-4o-mini)', async () => {
      process.env[ENV_KEY] = JSON.stringify({
        'gpt-4o-mini': { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('gpt-4o-mini')).toEqual({
        inputCentsPerMillionTokens: 15,
        outputCentsPerMillionTokens: 60,
      });
    });

    it('falls back to defaults (never crashes) on malformed JSON', async () => {
      process.env[ENV_KEY] = '{ not valid json';
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('claude-sonnet-4-6')).toEqual({
        inputCentsPerMillionTokens: 300,
        outputCentsPerMillionTokens: 1500,
      });
    });

    it('drops an individual malformed entry but keeps valid ones in the same payload', async () => {
      process.env[ENV_KEY] = JSON.stringify({
        'claude-sonnet-4-6': { inputCentsPerMillionTokens: 999, outputCentsPerMillionTokens: 1 },
        'bogus-model': { inputCentsPerMillionTokens: -5, outputCentsPerMillionTokens: 'nope' },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('claude-sonnet-4-6')).toEqual({
        inputCentsPerMillionTokens: 999,
        outputCentsPerMillionTokens: 1,
      });
      expect(resolveModelPricing('bogus-model')).toBeNull();
    });

    it('ignores a non-object JSON payload (e.g. an array or scalar)', async () => {
      process.env[ENV_KEY] = JSON.stringify([1, 2, 3]);
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('claude-sonnet-4-6')).toEqual({
        inputCentsPerMillionTokens: 300,
        outputCentsPerMillionTokens: 1500,
      });
    });

    it('a namespaced override key ("openai/gpt-4o-mini") matches the bare runtime id ops actually sees', async () => {
      // The natural shape for an OpenRouter-style AI_DEFAULT_MODEL — ops
      // writes the override with the same namespace the model id carries in
      // config, but resolveModelPricing() only ever sees/looks up the bare
      // last-segment id at call time.
      process.env[ENV_KEY] = JSON.stringify({
        'openai/gpt-4o-mini': { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('gpt-4o-mini')).toEqual({
        inputCentsPerMillionTokens: 15,
        outputCentsPerMillionTokens: 60,
      });
    });

    it('a bare override key ("gpt-4o-mini") matches a namespaced runtime id', async () => {
      process.env[ENV_KEY] = JSON.stringify({
        'gpt-4o-mini': { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('openai/gpt-4o-mini')).toEqual({
        inputCentsPerMillionTokens: 15,
        outputCentsPerMillionTokens: 60,
      });
    });

    it('normalizes override keys case-insensitively too, mirroring the lookup path', async () => {
      process.env[ENV_KEY] = JSON.stringify({
        'OpenAI/GPT-4o-Mini': { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
      });
      const { resolveModelPricing } = await freshModule();
      expect(resolveModelPricing('gpt-4o-mini')).toEqual({
        inputCentsPerMillionTokens: 15,
        outputCentsPerMillionTokens: 60,
      });
    });
  });
});
