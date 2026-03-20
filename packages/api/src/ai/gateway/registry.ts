import type { LLMProvider, LLMGatewayConfig } from './gateway';
import { StubProvider } from './providers';

export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();

  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  list(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  remove(name: string): boolean {
    return this.providers.delete(name);
  }

  toMap(): Map<string, LLMProvider> {
    return new Map(this.providers);
  }
}

export interface DefaultRegistryConfig {
  environment?: string;
}

export function createDefaultRegistry(config: DefaultRegistryConfig = {}): ProviderRegistry {
  const registry = new ProviderRegistry();
  const env = config.environment || process.env.NODE_ENV || 'development';

  // StubProvider is ONLY registered for local dev and tests.
  // Production and staging must have a real AI provider configured
  // via AI_PROVIDER_API_KEY and AI_PROVIDER_BASE_URL.
  if (env === 'development' || env === 'test' || env === 'dev') {
    registry.register(new StubProvider('stub'));
  }

  return registry;
}

export function resolveProvider(
  registry: ProviderRegistry,
  config: LLMGatewayConfig,
  taskType: string
): LLMProvider | undefined {
  const providerName =
    config.taskRouting && config.taskRouting[taskType]
      ? config.taskRouting[taskType]
      : config.defaultProvider;

  return registry.get(providerName);
}
