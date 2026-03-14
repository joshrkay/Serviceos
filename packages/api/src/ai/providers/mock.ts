import type { LLMProvider, LLMRequest, LLMResponse } from '../gateway/gateway';

/**
 * Deterministic mock provider for unit tests.
 * Returns configurable responses without any network calls.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  private responses: Map<string, string> = new Map();
  private callLog: LLMRequest[] = [];
  private defaultResponse: string;

  constructor(defaultResponse = '{"mock": true}') {
    this.defaultResponse = defaultResponse;
  }

  /** Prime a response for a specific model */
  setResponse(model: string, content: string): void {
    this.responses.set(model, content);
  }

  /** Set the fallback response for any model */
  setDefaultResponse(content: string): void {
    this.defaultResponse = content;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.callLog.push(request);
    const model = request.model ?? 'mock-model';
    const content = this.responses.get(model) ?? this.defaultResponse;
    return {
      content,
      model,
      provider: this.name,
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getCalls(): LLMRequest[] {
    return [...this.callLog];
  }

  reset(): void {
    this.callLog = [];
    this.responses.clear();
  }
}
