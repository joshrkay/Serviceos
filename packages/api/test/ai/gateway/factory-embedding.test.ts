/**
 * D1-2 — createEmbeddingProvider tests.
 *
 * The RAG ingestion path must construct its embedding provider through
 * the gateway factory rather than reaching for `OpenAICompatibleProvider`
 * directly (CLAUDE.md: "All AI calls route through LLM gateway").
 *
 * These tests pin the two behaviours app.ts depends on:
 *   - returns `null` when `AI_PROVIDER_API_KEY` is unset (so workers
 *     stay un-registered and the app still boots)
 *   - returns an `EmbeddingProvider` (with a working `createEmbedding()`)
 *     when the key is present
 *
 * The OpenAI SDK is mocked so no network calls are made.
 */
import { describe, it, expect, vi } from 'vitest';

// 1536 dims matches the production `text-embedding-3-small` contract
// enforced by OpenAICompatibleProvider.createEmbedding().
const FAKE_EMBEDDING = new Array(1536).fill(0).map((_, i) => i / 1536);

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(),
      },
    };
    embeddings = {
      create: vi.fn(() =>
        Promise.resolve({
          data: [{ embedding: FAKE_EMBEDDING }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
          model: 'text-embedding-3-small',
        }),
      ),
    };
    constructor(_args: unknown) {}
  }
  return { default: MockOpenAI };
});

import { createEmbeddingProvider } from '../../../src/ai/gateway/factory';
import type { AppConfig } from '../../../src/shared/config';

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'info',
    R2_BUCKET: 'serviceos-uploads',
    ...overrides,
  } as unknown as AppConfig;
}

describe('createEmbeddingProvider', () => {
  it('returns null when AI_PROVIDER_API_KEY is unset', () => {
    const provider = createEmbeddingProvider(cfg());
    expect(provider).toBeNull();
  });

  it('returns an EmbeddingProvider when AI_PROVIDER_API_KEY is set', async () => {
    const provider = createEmbeddingProvider(
      cfg({ AI_PROVIDER_API_KEY: 'sk-test' } as Partial<AppConfig>),
    );
    expect(provider).not.toBeNull();
    expect(typeof provider!.createEmbedding).toBe('function');

    const result = await provider!.createEmbedding('hello');
    expect(result.embedding).toHaveLength(1536);
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.tokenUsage).toBe(5);
  });

  it('honors AI_PROVIDER_BASE_URL override without throwing', () => {
    // Both should successfully construct. The base URL is an internal
    // concern of OpenAICompatibleProvider; this test pins that the
    // override path is wired up and doesn't blow up.
    const withDefault = createEmbeddingProvider(
      cfg({ AI_PROVIDER_API_KEY: 'sk-test' } as Partial<AppConfig>),
    );
    const withOverride = createEmbeddingProvider(
      cfg({
        AI_PROVIDER_API_KEY: 'sk-test',
        AI_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      } as Partial<AppConfig>),
    );
    expect(withDefault).not.toBeNull();
    expect(withOverride).not.toBeNull();
  });
});
