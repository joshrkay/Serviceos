import { LLMGateway } from './gateway';
import { OpenAICompatibleProvider } from '../providers/openai-compatible';
import { MockLLMProvider } from '../providers/mock';
import type { AppConfig } from '../../shared/config';
import type { GatewayLogger } from './gateway';

/**
 * Create the LLM gateway from application config.
 *
 * Switching providers is purely a .env change:
 *
 *   OpenAI:
 *     AI_PROVIDER_BASE_URL=https://api.openai.com/v1
 *     AI_PROVIDER_API_KEY=sk-...
 *     AI_DEFAULT_MODEL=gpt-4o-mini
 *
 *   OpenRouter:
 *     AI_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
 *     AI_PROVIDER_API_KEY=sk-or-...
 *     AI_DEFAULT_MODEL=openai/gpt-4o-mini
 *
 *   Any other OpenAI-compatible endpoint works the same way.
 */
export function createLLMGateway(config: AppConfig, logger?: GatewayLogger): LLMGateway {
  if (!config.AI_PROVIDER_API_KEY) {
    throw new Error(
      'AI_PROVIDER_API_KEY is not set. Add it to .env to enable AI features.'
    );
  }

  const provider = new OpenAICompatibleProvider({
    apiKey: config.AI_PROVIDER_API_KEY,
    baseURL: config.AI_PROVIDER_BASE_URL,
    // OpenRouter requires these headers to identify your app
    defaultHeaders:
      config.AI_PROVIDER_BASE_URL.includes('openrouter.ai')
        ? {
            'HTTP-Referer': 'https://serviceos.app',
            'X-Title': 'ServiceOS',
          }
        : undefined,
  });

  return new LLMGateway(provider, { defaultModel: config.AI_DEFAULT_MODEL }, logger);
}

/** Create a mock gateway for tests — no API key needed */
export function createMockLLMGateway(defaultResponse = '{"mock": true}'): {
  gateway: LLMGateway;
  provider: MockLLMProvider;
} {
  const provider = new MockLLMProvider(defaultResponse);
  const gateway = new LLMGateway(provider);
  return { gateway, provider };
}
