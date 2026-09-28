/**
 * #1331 — Voice Quality Layer 2 must exercise the provider production runs.
 *
 * Production (Railway prod/dev) runs the OpenAI-compatible gateway built by
 * `createLLMGateway(loadConfig(env))` from AI_PROVIDER_API_KEY /
 * AI_PROVIDER_BASE_URL (api.openai.com) / AI_*_MODEL (gpt-4o-mini). The
 * Anthropic account behind ANTHROPIC_API_KEY is out of credit and production
 * never calls it, so it may only be an explicit, logged local fallback.
 *
 * Seam 1: `selectLayer2Providers(env)` — pure, env in → plan out.
 */
import { describe, expect, it } from 'vitest';

import { selectLayer2Providers } from '../../src/ai/gateway/real-layer-two-factory';

/** Railway prod/dev AI env as of 2026-09 (what the Layer 2 workflows mirror). */
const PROD_AI_ENV = {
  AI_PROVIDER_API_KEY: 'sk-prod-test',
  AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
  AI_DEFAULT_MODEL: 'gpt-4o-mini',
  AI_LIGHTWEIGHT_MODEL: 'gpt-4o-mini',
  AI_STANDARD_MODEL: 'gpt-4o-mini',
  AI_COMPLEX_MODEL: 'gpt-4o',
  OPENAI_API_KEY: 'sk-speech-test',
};

describe('#1331 — selectLayer2Providers', () => {
  it('uses the production provider config (OpenAI, gpt-4o-mini) even when ANTHROPIC_API_KEY is also set', () => {
    const plan = selectLayer2Providers({ ...PROD_AI_ENV, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(plan).toEqual({
      ok: true,
      llm: {
        kind: 'production',
        keySource: 'AI_PROVIDER_API_KEY',
        apiKey: 'sk-prod-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      },
      speechApiKey: 'sk-speech-test',
      notice:
        'Layer 2 LLM: production provider config via createLLMGateway → api.openai.com model=gpt-4o-mini (key: AI_PROVIDER_API_KEY)',
    });
  });

  it('falls back to the Anthropic harness (Haiku 4.5) only when AI_PROVIDER_API_KEY is unset, and says it is not production', () => {
    const plan = selectLayer2Providers({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-speech-test',
    });
    expect(plan).toEqual({
      ok: true,
      llm: {
        kind: 'anthropic-fallback',
        keySource: 'ANTHROPIC_API_KEY',
        apiKey: 'sk-ant-test',
        baseUrl: 'https://api.anthropic.com/v1/',
        model: 'claude-haiku-4-5-20251001',
      },
      speechApiKey: 'sk-speech-test',
      notice:
        'Layer 2 LLM: Anthropic fallback harness gateway → api.anthropic.com model=claude-haiku-4-5-20251001 (key: ANTHROPIC_API_KEY) — NOT the production provider',
    });
  });

  it('fails cleanly, naming the production key, when no LLM key is set', () => {
    // GitHub Actions renders an unset secret as '' — treat blank as absent.
    expect(selectLayer2Providers({ AI_PROVIDER_API_KEY: '', ANTHROPIC_API_KEY: '  ', OPENAI_API_KEY: 'sk-speech-test' })).toEqual({
      ok: false,
      error:
        'Layer 2 requires AI_PROVIDER_API_KEY (the production LLM provider; ANTHROPIC_API_KEY is a local-only fallback).',
    });
  });

  it('fails cleanly when the speech key (Whisper STT + OpenAI TTS) is missing', () => {
    expect(selectLayer2Providers({ AI_PROVIDER_API_KEY: 'sk-prod-test' })).toEqual({
      ok: false,
      error: 'Layer 2 requires OPENAI_API_KEY (Whisper STT + OpenAI TTS).',
    });
  });
});
